import { strFromU8, unzipSync } from 'fflate';
import { createStore, get, set, type UseStore } from 'idb-keyval';
import type { WaveformDefinition, WaveformLibrary } from '@dg-agent/core';
import { createBasicWaveformLibrary, parsePulseText, type ParsedPulse } from '@dg-kit/waveforms';
import { z } from 'zod';

const CUSTOM_WAVEFORMS_KEY = 'custom-waveforms';

const waveformSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  frames: z.array(z.tuple([z.number(), z.number()])).min(1),
});

export class BrowserWaveformLibrary implements WaveformLibrary {
  private readonly builtins = createBasicWaveformLibrary();
  private readonly store: UseStore;

  constructor(dbName = 'dg-agent-waveforms', storeName = 'waveforms') {
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

  /** WaveformLibrary.save — alias of saveCustom so runtime tools can write
   *  to the library without coupling to BrowserWaveformLibrary specifics. */
  async save(waveform: WaveformDefinition): Promise<void> {
    return this.saveCustom(waveform);
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
          imported.push(createImportedWaveform(entryName, parsePulseText(strFromU8(content))));
        }
      } else {
        const text = new TextDecoder().decode(bytes);
        imported.push(createImportedWaveform(file.name, parsePulseText(text)));
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

function createImportedWaveform(fileName: string, parsed: ParsedPulse): WaveformDefinition {
  const fallbackName = fileName.replace(/\.(pulse|zip)$/i, '');
  // Prefer the descriptive name embedded in the .pulse file (often Chinese
  // like "水滴" or "海浪"); fall back to the file name when missing.
  const displayName = parsed.name || fallbackName;
  const idSeed = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const safeId = `custom-${idSeed || 'wave'}-${Date.now().toString(36)}`;
  return {
    id: safeId,
    name: displayName,
    frames: parsed.frames,
  };
}

function cloneWaveform(waveform: WaveformDefinition): WaveformDefinition {
  return {
    ...waveform,
    frames: waveform.frames.map((frame) => [frame[0], frame[1]]),
  };
}
