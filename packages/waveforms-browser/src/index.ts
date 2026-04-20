import { strFromU8, unzipSync } from 'fflate';
import { createStore, get, set, type UseStore } from 'idb-keyval';
import type { WaveformLibraryPort } from '@dg-agent/contracts';
import type { WaveFrame, WaveformDefinition } from '@dg-agent/core';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms-basic';
import { z } from 'zod';

const CUSTOM_WAVEFORMS_KEY = 'custom-waveforms';

const waveformSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  frames: z.array(z.tuple([z.number(), z.number()])).min(1),
});

export class BrowserWaveformLibrary implements WaveformLibraryPort {
  private readonly builtins = createBasicWaveformLibrary();
  private readonly store: UseStore;

  constructor(dbName = 'dg-agent-rewrite-waveforms', storeName = 'waveforms') {
    this.store = createStore(dbName, storeName);
  }

  async getById(id: string): Promise<WaveformDefinition | null> {
    const builtin = await this.builtins.getById(id);
    if (builtin) return builtin;

    const custom = await this.getCustomWaveforms();
    return custom.find((waveform) => waveform.id === id) ?? null;
  }

  async list(): Promise<WaveformDefinition[]> {
    const [builtins, custom] = await Promise.all([this.builtins.list(), this.getCustomWaveforms()]);
    return [...builtins, ...custom];
  }

  async listCustom(): Promise<WaveformDefinition[]> {
    return this.getCustomWaveforms();
  }

  async saveCustom(waveform: WaveformDefinition): Promise<void> {
    const parsed = waveformSchema.parse(waveform);
    const custom = await this.getCustomWaveforms();
    const next = [parsed, ...custom.filter((item) => item.id !== parsed.id)];
    await set(CUSTOM_WAVEFORMS_KEY, next, this.store);
  }

  async removeCustom(id: string): Promise<void> {
    const custom = await this.getCustomWaveforms();
    await set(
      CUSTOM_WAVEFORMS_KEY,
      custom.filter((item) => item.id !== id),
      this.store,
    );
  }

  async importFiles(files: FileList | File[]): Promise<WaveformDefinition[]> {
    const imported: WaveformDefinition[] = [];

    for (const file of Array.from(files)) {
      const bytes = new Uint8Array(await file.arrayBuffer());

      if (/\.zip$/i.test(file.name)) {
        const entries = unzipSync(bytes);
        for (const [entryName, content] of Object.entries(entries)) {
          if (!/\.pulse$/i.test(entryName)) continue;
          const waveform = createImportedWaveform(entryName, parsePulseText(strFromU8(content)));
          imported.push(waveform);
        }
      } else {
        const text = new TextDecoder().decode(bytes);
        const waveform = createImportedWaveform(file.name, parsePulseText(text));
        imported.push(waveform);
      }
    }

    if (imported.length === 0) {
      throw new Error('没有找到支持的波形文件');
    }

    const custom = await this.getCustomWaveforms();
    const merged = [
      ...imported,
      ...custom.filter((existing) => !imported.some((item) => item.id === existing.id)),
    ];
    await set(CUSTOM_WAVEFORMS_KEY, merged, this.store);
    return imported;
  }

  private async getCustomWaveforms(): Promise<WaveformDefinition[]> {
    const raw = (await get<unknown>(CUSTOM_WAVEFORMS_KEY, this.store)) ?? [];
    const parsed = z.array(waveformSchema).safeParse(raw);
    return parsed.success ? parsed.data.map(cloneWaveform) : [];
  }
}

function createImportedWaveform(fileName: string, frames: WaveFrame[]): WaveformDefinition {
  const baseName = fileName.replace(/\.(pulse|zip)$/i, '');
  const safeId = `custom-${
    baseName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'wave'
  }-${Date.now().toString(36)}`;
  return {
    id: safeId,
    name: baseName,
    description: '从 Dungeonlab+pulse 文件导入',
    frames,
  };
}

function cloneWaveform(waveform: WaveformDefinition): WaveformDefinition {
  return {
    ...waveform,
    frames: waveform.frames.map((frame) => [frame[0], frame[1]]),
  };
}

const FREQ_DATASET = [
  10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
];
const DURATION_DATASET = [1, 2, 3, 4, 5, 8, 10, 15, 20, 30, 40, 50, 60];

function freqFromIndex(index: number): number {
  const clamped = Math.max(0, Math.min(FREQ_DATASET.length - 1, Math.floor(index)));
  return FREQ_DATASET[clamped] ?? 10;
}

function durationFromIndex(index: number): number {
  const clamped = Math.max(0, Math.min(DURATION_DATASET.length - 1, Math.floor(index)));
  return DURATION_DATASET[clamped] ?? 1;
}

function encodeFreq(value: number): number {
  let output: number;
  if (value >= 10 && value <= 100) output = value;
  else if (value > 100 && value <= 600) output = (value - 100) / 5 + 100;
  else if (value > 600 && value <= 1000) output = (value - 600) / 10 + 200;
  else if (value < 10) output = 10;
  else output = 240;
  return Math.max(10, Math.min(240, Math.round(output)));
}

interface ShapePoint {
  strength: number;
}

interface Section {
  frequencyMode: number;
  shape: ShapePoint[];
  startFrequency: number;
  endFrequency: number;
  duration: number;
}

export function parsePulseText(data: string): WaveFrame[] {
  const trimmed = data.trim();
  if (!/^Dungeonlab\+pulse:/i.test(trimmed)) {
    throw new Error("脉冲格式无效，必须以 'Dungeonlab+pulse:' 开头");
  }

  const cleanData = trimmed.replace(/^Dungeonlab\+pulse:/i, '');
  const sectionParts = cleanData.split('+section+');
  if (sectionParts.length === 0 || !sectionParts[0]) {
    throw new Error('脉冲数据无效，未找到任何分段');
  }

  const firstPart = sectionParts[0];
  const equalIndex = firstPart.indexOf('=');
  if (equalIndex === -1) {
    throw new Error("脉冲格式无效，缺少 '=' 分隔符");
  }

  const sections: Section[] = [];
  const firstSectionData = firstPart.substring(equalIndex + 1);
  const allSectionData = [firstSectionData, ...sectionParts.slice(1)];

  for (let index = 0; index < allSectionData.length && index < 10; index++) {
    const sectionData = allSectionData[index];
    if (!sectionData) continue;

    const slashIndex = sectionData.indexOf('/');
    if (slashIndex === -1) {
      throw new Error(`第 ${index + 1} 段缺少 '/' 分隔符`);
    }

    const headerPart = sectionData.substring(0, slashIndex);
    const shapePart = sectionData.substring(slashIndex + 1);
    const headerValues = headerPart.split(',');

    const freqRange1Index = Number(headerValues[0]) || 0;
    const freqRange2Index = Number(headerValues[1]) || 0;
    const durationIndex = Number(headerValues[2]) || 0;
    const freqMode = Number(headerValues[3]) || 1;
    const enabled = headerValues[4] !== '0';

    const shapePoints: ShapePoint[] = [];
    for (const item of shapePart.split(',')) {
      if (!item) continue;
      const [strengthStr] = item.split('-');
      const strength = Math.round(Number(strengthStr) || 0);
      shapePoints.push({ strength: Math.max(0, Math.min(100, strength)) });
    }

    if (shapePoints.length < 2) {
      throw new Error(`第 ${index + 1} 段至少需要 2 个形状点`);
    }

    if (enabled) {
      sections.push({
        frequencyMode: freqMode,
        shape: shapePoints,
        startFrequency: freqFromIndex(freqRange1Index),
        endFrequency: freqFromIndex(freqRange2Index),
        duration: durationFromIndex(durationIndex),
      });
    }
  }

  if (sections.length === 0) {
    throw new Error('脉冲数据无效，没有启用的分段');
  }

  const frames: WaveFrame[] = [];
  for (const section of sections) {
    const shapeCount = section.shape.length;
    const pulseElementDuration = shapeCount;
    const sectionDuration = section.duration;
    const { startFrequency, endFrequency, frequencyMode } = section;
    const pulseElementCount = Math.max(1, Math.ceil(sectionDuration / pulseElementDuration));
    const actualDuration = pulseElementCount * pulseElementDuration;

    for (let elementIndex = 0; elementIndex < pulseElementCount; elementIndex++) {
      for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex++) {
        const strength = section.shape[shapeIndex]?.strength ?? 0;
        const currentTime = elementIndex * pulseElementDuration + shapeIndex;
        const sectionProgress = currentTime / actualDuration;
        const elementProgress = shapeIndex / shapeCount;

        let rawFreq: number;
        switch (frequencyMode) {
          case 2:
            rawFreq = startFrequency + (endFrequency - startFrequency) * sectionProgress;
            break;
          case 3:
            rawFreq = startFrequency + (endFrequency - startFrequency) * elementProgress;
            break;
          case 4: {
            const progress = pulseElementCount > 1 ? elementIndex / (pulseElementCount - 1) : 0;
            rawFreq = startFrequency + (endFrequency - startFrequency) * progress;
            break;
          }
          default:
            rawFreq = startFrequency;
        }

        frames.push([encodeFreq(rawFreq), Math.max(0, Math.min(100, Math.round(strength)))]);
      }
    }
  }

  if (frames.length === 0) {
    throw new Error('解析后的波形为空');
  }

  return frames;
}
