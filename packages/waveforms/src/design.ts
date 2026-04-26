import type { WaveFrame } from '@dg-agent/core';

export type DesignSegment = RampSegment | HoldSegment | PulseSegment | SilenceSegment;

export interface RampSegment {
  type: 'ramp';
  /** Start intensity, 0-100. */
  from: number;
  /** End intensity, 0-100. */
  to: number;
  /** Total segment duration in milliseconds; rounded to 25 ms frame grid. */
  durationMs: number;
  /** Pulse-frequency value in ms (10-1000). Default 100. */
  frequencyMs?: number;
}

export interface HoldSegment {
  type: 'hold';
  intensity: number;
  durationMs: number;
  frequencyMs?: number;
}

export interface PulseSegment {
  type: 'pulse';
  intensity: number;
  /** On phase in milliseconds; rounded to 25 ms grid. */
  onMs: number;
  /** Off phase in milliseconds; rounded to 25 ms grid. */
  offMs: number;
  /** Number of on/off cycles. */
  count: number;
  frequencyMs?: number;
}

export interface SilenceSegment {
  type: 'silence';
  durationMs: number;
}

const FRAME_GRID_MS = 25;
const DEFAULT_FREQUENCY_MS = 100;
const MIN_FREQUENCY_MS = 10;
const MAX_FREQUENCY_MS = 1000;
const TOTAL_DURATION_LIMIT_MS = 30_000;

function clampIntensity(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampFrequency(value: number | undefined): number {
  const v = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_FREQUENCY_MS;
  return Math.max(MIN_FREQUENCY_MS, Math.min(MAX_FREQUENCY_MS, Math.round(v)));
}

function frameCount(durationMs: number): number {
  return Math.max(1, Math.round(durationMs / FRAME_GRID_MS));
}

function compileSegment(segment: DesignSegment): WaveFrame[] {
  switch (segment.type) {
    case 'ramp': {
      const freq = clampFrequency(segment.frequencyMs);
      const count = frameCount(segment.durationMs);
      const from = clampIntensity(segment.from);
      const to = clampIntensity(segment.to);
      const frames: WaveFrame[] = [];
      for (let i = 0; i < count; i += 1) {
        const t = count === 1 ? 1 : i / (count - 1);
        const intensity = clampIntensity(from + (to - from) * t);
        frames.push([freq, intensity]);
      }
      return frames;
    }
    case 'hold': {
      const freq = clampFrequency(segment.frequencyMs);
      const count = frameCount(segment.durationMs);
      const intensity = clampIntensity(segment.intensity);
      return Array.from({ length: count }, () => [freq, intensity] as WaveFrame);
    }
    case 'pulse': {
      const freq = clampFrequency(segment.frequencyMs);
      const intensity = clampIntensity(segment.intensity);
      const onCount = frameCount(segment.onMs);
      const offCount = frameCount(segment.offMs);
      const cycles = Math.max(1, Math.round(segment.count));
      const frames: WaveFrame[] = [];
      for (let cycle = 0; cycle < cycles; cycle += 1) {
        for (let i = 0; i < onCount; i += 1) frames.push([freq, intensity]);
        for (let i = 0; i < offCount; i += 1) frames.push([freq, 0]);
      }
      return frames;
    }
    case 'silence': {
      const count = frameCount(segment.durationMs);
      // Frequency value is irrelevant when intensity is 0; pick the default to
      // avoid surprising downstream encoders that special-case 0 frequency.
      return Array.from({ length: count }, () => [DEFAULT_FREQUENCY_MS, 0] as WaveFrame);
    }
  }
}

export interface CompiledDesign {
  frames: WaveFrame[];
  totalDurationMs: number;
}

export function compileWaveformDesign(segments: DesignSegment[]): CompiledDesign {
  if (segments.length === 0) {
    throw new Error('设计波形需要至少一个段落');
  }
  const frames: WaveFrame[] = [];
  for (const segment of segments) {
    for (const frame of compileSegment(segment)) {
      frames.push(frame);
    }
  }
  const totalDurationMs = frames.length * FRAME_GRID_MS;
  if (totalDurationMs > TOTAL_DURATION_LIMIT_MS) {
    throw new Error(`波形总时长 ${totalDurationMs}ms 超过上限 ${TOTAL_DURATION_LIMIT_MS}ms`);
  }
  return { frames, totalDurationMs };
}
