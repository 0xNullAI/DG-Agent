import type { WaveformLibraryPort } from '@dg-agent/contracts';
import type { WaveformDefinition } from '@dg-agent/core';

const BUILTIN_WAVEFORMS: WaveformDefinition[] = [
  {
    id: 'pulse',
    name: 'Pulse',
    description: 'Short regular pulses.',
    frames: Array.from({ length: 10 }, () => [10, 60] as [number, number]),
  },
  {
    id: 'gentle',
    name: 'Gentle',
    description: 'Soft alternating pulse pattern.',
    frames: [
      [12, 20],
      [12, 30],
      [12, 40],
      [12, 50],
      [12, 40],
      [12, 30],
      [12, 20],
      [12, 10],
    ],
  },
  {
    id: 'breath',
    name: 'Breath',
    description: 'Slow inhale-exhale style wave.',
    frames: [
      [18, 10],
      [18, 18],
      [18, 26],
      [18, 34],
      [18, 42],
      [18, 50],
      [18, 42],
      [18, 34],
      [18, 26],
      [18, 18],
    ],
  },
];

export class BasicWaveformLibrary implements WaveformLibraryPort {
  private readonly byId = new Map(BUILTIN_WAVEFORMS.map((waveform) => [waveform.id, cloneWaveform(waveform)]));

  async getById(id: string): Promise<WaveformDefinition | null> {
    const waveform = this.byId.get(id);
    return waveform ? cloneWaveform(waveform) : null;
  }

  async list(): Promise<WaveformDefinition[]> {
    return [...this.byId.values()].map(cloneWaveform);
  }
}

export function createBasicWaveformLibrary(): WaveformLibraryPort {
  return new BasicWaveformLibrary();
}

function cloneWaveform(waveform: WaveformDefinition): WaveformDefinition {
  return {
    ...waveform,
    frames: waveform.frames.map((frame) => [frame[0], frame[1]]),
  };
}
