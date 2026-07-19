import { describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  createEmptySensorState,
  withSensorLastReading,
  type ActionContext,
  type SessionSnapshot,
} from '@dg-agent/core';
import { createEmptyOpossumState } from '@dg-kit/protocol';
import {
  createBuildBrowserInstructions,
  type BrowserInstructionsInput,
} from './build-browser-instructions.js';

const context: ActionContext = {
  sessionId: 's1',
  sourceType: 'web',
  traceId: 't1',
};

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    id: 's1',
    createdAt: 0,
    updatedAt: 0,
    messages: [],
    deviceState: createEmptyDeviceState(),
    ...overrides,
  };
}

function baseInput(overrides: Partial<BrowserInstructionsInput> = {}): BrowserInstructionsInput {
  return {
    session: session(),
    context,
    isFirstIteration: true,
    turnToolCalls: [],
    ...overrides,
  };
}

const settings = {
  promptPresetId: 'gentle',
  savedPromptPresets: [],
  maxStrengthA: 50,
  maxStrengthB: 50,
  maxOpossumIntensityA: 40,
  maxOpossumIntensityB: 40,
};

describe('createBuildBrowserInstructions', () => {
  it('Coyote-only: never mentions Opossum or sensors', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(baseInput());

    expect(instructions).toContain('郊狼（Coyote）');
    expect(instructions).not.toContain('负鼠');
    expect(instructions).not.toContain('爪印');
    expect(instructions).not.toContain('灵猫');
    expect(instructions).not.toContain('vibrate_start');
  });

  it('Coyote + Opossum: mentions Opossum mapping and status, still no sensors', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        opossumState: {
          ...createEmptyOpossumState(),
          connected: true,
          intensityA: 12,
          intensityB: 0,
        },
      }),
    );

    expect(instructions).toContain('负鼠（Opossum）');
    expect(instructions).toContain('vibrate_start');
    expect(instructions).toContain('vibrate_adjust');
    expect(instructions).toContain('vibrate_stop');
    // Status block reports the configured user cap, not a hardcoded number.
    expect(instructions).toContain('强度 12 / 上限 40');
    expect(instructions).not.toContain('爪印');
    expect(instructions).not.toContain('灵猫');
  });

  it('all four device kinds: mentions every device and surfaces the last sensor reading', () => {
    const build = createBuildBrowserInstructions(settings);
    const metadata = withSensorLastReading(undefined, 'paw-prints', {
      summary: '按钮触发（事件1）',
      firedAt: Date.parse('2026-07-19T00:00:00Z'),
    });

    const instructions = build(
      baseInput({
        session: session({ metadata }),
        opossumState: { ...createEmptyOpossumState(), connected: true },
        pawPrintsState: { ...createEmptySensorState(), connected: true, deviceName: '47L120001' },
        civetEdgingState: { ...createEmptySensorState(), connected: false },
      }),
    );

    expect(instructions).toContain('负鼠（Opossum）');
    expect(instructions).toContain('爪印（按键 / 姿态传感器）');
    expect(instructions).toContain('灵猫（压力传感器）');
    expect(instructions).toContain('按钮触发（事件1）');
    expect(instructions).toContain('内部提醒');
    // civet-edging is configured but disconnected — still described, status shows 未连接.
    expect(instructions).toContain('灵猫：');
  });

  it('a sensor with no recorded reading yet reports 暂无', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        pawPrintsState: { ...createEmptySensorState(), connected: true },
      }),
    );

    expect(instructions).toContain('最近读数：暂无');
  });

  it('includes a 近段汇总 line under 最近读数 when a rolling summary is provided', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        pawPrintsState: { ...createEmptySensorState(), connected: true },
        civetEdgingState: { ...createEmptySensorState(), connected: true },
        pawPrintsSummary: '60s 内触发 3 次，最近事件5',
        civetSummary: '当前 12.0kPa，30s 内 10.0~14.0kPa，趋势上升',
      }),
    );

    expect(instructions).toContain('近段汇总：60s 内触发 3 次，最近事件5');
    expect(instructions).toContain('近段汇总：当前 12.0kPa，30s 内 10.0~14.0kPa，趋势上升');
  });

  it('omits the 近段汇总 line entirely when no summary is provided yet', () => {
    const build = createBuildBrowserInstructions(settings);
    const instructions = build(
      baseInput({
        pawPrintsState: { ...createEmptySensorState(), connected: true },
      }),
    );

    expect(instructions).not.toContain('近段汇总');
  });
});
