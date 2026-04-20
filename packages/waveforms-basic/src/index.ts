import type { WaveformLibraryPort } from '@dg-agent/contracts';
import type { WaveformDefinition } from '@dg-agent/core';

const BUILTIN_WAVEFORMS: WaveformDefinition[] = [
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
    frames: Array.from({ length: 10 }, () => [10, 30] as [number, number]),
  },
  {
    id: 'pulse_mid',
    name: '中脉冲',
    description: '中等强度的规律节奏',
    frames: Array.from({ length: 10 }, () => [10, 60] as [number, number]),
  },
  {
    id: 'pulse_high',
    name: '高脉冲',
    description: '强烈的规律节奏',
    frames: Array.from({ length: 10 }, () => [10, 100] as [number, number]),
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

export class BasicWaveformLibrary implements WaveformLibraryPort {
  private readonly byId = new Map(
    BUILTIN_WAVEFORMS.map((waveform) => [waveform.id, cloneWaveform(waveform)]),
  );

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
