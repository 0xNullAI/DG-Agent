/**
 * waveforms.ts — User waveform library.
 *
 * All playable waveforms live here: defaults seeded on first run, user
 * imports, and edits. Persisted to localStorage. The agent tool layer
 * resolves a waveform by id and hands the resulting WaveFrame[] to the
 * bluetooth sendWave() call.
 *
 * Supported imports:
 *  - A single Dungeonlab+pulse plaintext file (.pulse)
 *  - A ZIP containing multiple .pulse files
 *
 * Parser ported from the MIT-licensed project
 *   https://github.com/FengYing1314/openclaw-plugin-dg-lab
 * with hex packing replaced by direct WaveFrame[] emission.
 */

import type { WaveFrame, UserWaveform } from '../types';
import { unzipSync, strFromU8 } from 'fflate';

const STORAGE_KEY = 'dg-agent:waveforms';

// ---------------------------------------------------------------------------
// Defaults — six built-in presets, seeded on first run.
// ---------------------------------------------------------------------------

const DEFAULTS: UserWaveform[] = [
  {
    id: 'breath',
    name: '呼吸',
    description: '渐强渐弱，最温柔的铺垫波形',
    frames: [
      [10, 0],
      [10, 20],
      [10, 40],
      [10, 60],
      [10, 80],
      [10, 100],
      [10, 100],
      [10, 100],
      [10, 0],
      [10, 0],
      [10, 0],
      [10, 0],
    ],
  },
  {
    id: 'tide',
    name: '潮汐',
    description: '波浪般起伏的慢节奏',
    frames: [
      [10, 0],
      [11, 16],
      [13, 33],
      [14, 50],
      [16, 66],
      [18, 83],
      [19, 100],
      [21, 92],
      [22, 84],
      [24, 76],
      [26, 68],
      [26, 0],
      [27, 16],
      [29, 33],
      [30, 50],
      [32, 66],
      [34, 83],
      [35, 100],
      [37, 92],
      [38, 84],
      [40, 76],
      [42, 68],
    ],
  },
  {
    id: 'pulse_low',
    name: '低脉冲',
    description: '轻柔的规律节奏',
    frames: Array.from({ length: 10 }, (): WaveFrame => [10, 30]),
  },
  {
    id: 'pulse_mid',
    name: '中脉冲',
    description: '中等强度的规律节奏',
    frames: Array.from({ length: 10 }, (): WaveFrame => [10, 60]),
  },
  {
    id: 'pulse_high',
    name: '高脉冲',
    description: '强烈的规律节奏',
    frames: Array.from({ length: 10 }, (): WaveFrame => [10, 100]),
  },
  {
    id: 'tap',
    name: '敲击',
    description: '带节奏停顿的点触感',
    frames: [
      [10, 100],
      [10, 0],
      [10, 0],
      [10, 100],
      [10, 0],
      [10, 0],
    ],
  },
];

function cloneDefaults(): UserWaveform[] {
  return DEFAULTS.map((w) => ({
    ...w,
    frames: w.frames.map((f): WaveFrame => [f[0], f[1]]),
  }));
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let store: UserWaveform[] = [];
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as UserWaveform[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        store = parsed.filter(isValidWaveform);
        if (store.length > 0) return;
      }
    }
  } catch (_) {
    /* fall through to seed */
  }
  store = cloneDefaults();
  persist();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch (_) {
    /* */
  }
}

function isValidWaveform(w: unknown): w is UserWaveform {
  if (!w || typeof w !== 'object') return false;
  const o = w as UserWaveform;
  return (
    typeof o.id === 'string' &&
    typeof o.name === 'string' &&
    Array.isArray(o.frames) &&
    o.frames.length > 0 &&
    o.frames.every(
      (f) =>
        Array.isArray(f) && f.length === 2 && typeof f[0] === 'number' && typeof f[1] === 'number',
    )
  );
}

function genId(): string {
  return 'w_' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getAll(): readonly UserWaveform[] {
  load();
  return store;
}

export function getById(id: string): UserWaveform | undefined {
  load();
  return store.find((w) => w.id === id);
}

export function getFramesById(id: string): WaveFrame[] | undefined {
  const w = getById(id);
  return w ? w.frames.slice() : undefined;
}

export function updateMeta(id: string, patch: { name?: string; description?: string }): void {
  load();
  const w = store.find((x) => x.id === id);
  if (!w) return;
  if (typeof patch.name === 'string') w.name = patch.name;
  if (typeof patch.description === 'string') w.description = patch.description;
  persist();
}

export function remove(id: string): boolean {
  load();
  if (store.length <= 1) return false;
  const i = store.findIndex((w) => w.id === id);
  if (i < 0) return false;
  store.splice(i, 1);
  persist();
  return true;
}

export function restoreDefaults(): void {
  store = cloneDefaults();
  loaded = true;
  persist();
}

export function addWaveform(w: {
  name: string;
  description?: string;
  frames: WaveFrame[];
}): UserWaveform {
  load();
  const entry: UserWaveform = {
    id: genId(),
    name: w.name,
    description: w.description || '',
    frames: w.frames,
  };
  store.push(entry);
  persist();
  return entry;
}

// ---------------------------------------------------------------------------
// Import entry points
// ---------------------------------------------------------------------------

export async function importFiles(
  files: File[],
): Promise<{ added: UserWaveform[]; errors: string[] }> {
  const added: UserWaveform[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      if (/\.zip$/i.test(file.name)) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const entries = unzipSync(buf);
        for (const [entryName, bytes] of Object.entries(entries)) {
          if (!/\.pulse$/i.test(entryName)) continue;
          try {
            const text = strFromU8(bytes);
            const frames = parsePulseText(text);
            added.push(addWaveform({ name: baseName(entryName), frames }));
          } catch (e: any) {
            errors.push(`${entryName}: ${e.message || e}`);
          }
        }
      } else {
        const text = await file.text();
        const frames = parsePulseText(text);
        added.push(addWaveform({ name: baseName(file.name), frames }));
      }
    } catch (e: any) {
      errors.push(`${file.name}: ${e.message || e}`);
    }
  }

  return { added, errors };
}

function baseName(filename: string): string {
  return filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------------
// Pulse plaintext parser
// Ported from FengYing1314/openclaw-plugin-dg-lab (MIT) — emits WaveFrame[]
// instead of hex strings. The parser outputs one frame per 100ms at the
// internal rate we already use for presets and custom waves.
// ---------------------------------------------------------------------------

const FREQUENCY_DATASET: number[] = [
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
  34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 52, 54, 56, 58, 60, 62, 64,
  66, 68, 70, 72, 74, 76, 78, 80, 85, 90, 95, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200,
  233, 266, 300, 333, 366, 400, 450, 500, 550, 600, 700, 800, 900, 1000,
];

const DURATION_DATASET: number[] = Array.from({ length: 100 }, (_, i) => i + 1);

function freqFromIndex(i: number): number {
  const c = Math.max(0, Math.min(FREQUENCY_DATASET.length - 1, Math.floor(i)));
  return FREQUENCY_DATASET[c] ?? 10;
}

function durationFromIndex(i: number): number {
  const c = Math.max(0, Math.min(DURATION_DATASET.length - 1, Math.floor(i)));
  return DURATION_DATASET[c] ?? 1;
}

/** Map a raw frequency value (ms) to the V3 encoded byte (10-240). */
function encodeFreq(x: number): number {
  let o: number;
  if (x >= 10 && x <= 100) o = x;
  else if (x > 100 && x <= 600) o = (x - 100) / 5 + 100;
  else if (x > 600 && x <= 1000) o = (x - 600) / 10 + 200;
  else if (x < 10) o = 10;
  else o = 240;
  return Math.max(10, Math.min(240, Math.round(o)));
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

/**
 * Parse a Dungeonlab+pulse plaintext string into a flat WaveFrame[] suitable
 * for direct playback by bluetooth.sendWave().
 */
export function parsePulseText(data: string): WaveFrame[] {
  const trimmed = data.trim();
  if (!/^Dungeonlab\+pulse:/i.test(trimmed)) {
    throw new Error("无效的波形格式：必须以 'Dungeonlab+pulse:' 开头");
  }

  const cleanData = trimmed.replace(/^Dungeonlab\+pulse:/i, '');
  const sectionParts = cleanData.split('+section+');
  if (sectionParts.length === 0 || !sectionParts[0]) {
    throw new Error('无效的波形数据：未找到小节');
  }

  const firstPart = sectionParts[0];
  const equalIdx = firstPart.indexOf('=');
  if (equalIdx === -1) throw new Error("无效的波形格式：缺少 '=' 分隔符");

  const sections: Section[] = [];
  const firstSectionData = firstPart.substring(equalIdx + 1);
  const allSectionData = [firstSectionData, ...sectionParts.slice(1)];

  for (let i = 0; i < allSectionData.length && i < 10; i++) {
    const sectionData = allSectionData[i];
    if (!sectionData) continue;

    const slashIdx = sectionData.indexOf('/');
    if (slashIdx === -1) throw new Error(`小节 ${i + 1} 缺少 '/' 分隔符`);

    const headerPart = sectionData.substring(0, slashIdx);
    const shapePart = sectionData.substring(slashIdx + 1);

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
      throw new Error(`小节 ${i + 1} 必须至少有 2 个形状点`);
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

  if (sections.length === 0) throw new Error('无效的波形数据：没有启用的小节');

  const frames: WaveFrame[] = [];
  for (const section of sections) {
    const shapeCount = section.shape.length;
    const pulseElementDuration = shapeCount;
    const sectionDuration = section.duration;
    const { startFrequency: startFreq, endFrequency: endFreq, frequencyMode: mode } = section;

    const pulseElementCount = Math.max(1, Math.ceil(sectionDuration / pulseElementDuration));
    const actualDuration = pulseElementCount * pulseElementDuration;

    for (let elementIdx = 0; elementIdx < pulseElementCount; elementIdx++) {
      for (let shapeIdx = 0; shapeIdx < shapeCount; shapeIdx++) {
        const strength = section.shape[shapeIdx]?.strength ?? 0;
        const currentTime = elementIdx * pulseElementDuration + shapeIdx;
        const sectionProgress = currentTime / actualDuration;
        const elementProgress = shapeIdx / shapeCount;

        let rawFreq: number;
        switch (mode) {
          case 2:
            rawFreq = startFreq + (endFreq - startFreq) * sectionProgress;
            break;
          case 3:
            rawFreq = startFreq + (endFreq - startFreq) * elementProgress;
            break;
          case 4: {
            const p = pulseElementCount > 1 ? elementIdx / (pulseElementCount - 1) : 0;
            rawFreq = startFreq + (endFreq - startFreq) * p;
            break;
          }
          default:
            rawFreq = startFreq;
        }
        frames.push([encodeFreq(rawFreq), Math.max(0, Math.min(100, Math.round(strength)))]);
      }
    }
  }

  if (frames.length === 0) throw new Error('解析结果为空');
  return frames;
}
