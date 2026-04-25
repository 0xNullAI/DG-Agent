import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState } from '@dg-agent/core';
import { createBuildBrowserInstructions } from './build-browser-instructions.js';
import type { BrowserInstructionSettings } from './build-browser-instructions.js';

function makeSettings(overrides?: Partial<BrowserInstructionSettings>): BrowserInstructionSettings {
  return {
    promptPresetId: 'gentle',
    savedPromptPresets: [],
    maxStrengthA: 100,
    maxStrengthB: 100,
    maxAdjustStrengthCallsPerTurn: 5,
    maxAdjustStrengthStep: 10,
    ...overrides,
  };
}

function makeInput(overrides?: {
  isFirstIteration?: boolean;
  sourceType?: 'web' | 'system' | 'bridge-qq' | 'bridge-telegram';
  turnToolCalls?: Array<{ name: string; argsJson: string }>;
  deviceState?: ReturnType<typeof createEmptyDeviceState>;
}) {
  const deviceState = overrides?.deviceState ?? { ...createEmptyDeviceState(), connected: true };
  return {
    session: {
      id: 'test',
      createdAt: 0,
      updatedAt: 0,
      messages: [],
      deviceState,
    },
    context: {
      sessionId: 'test',
      sourceType: (overrides?.sourceType ?? 'web') as
        | 'web'
        | 'system'
        | 'bridge-qq'
        | 'bridge-telegram',
      traceId: 'trace-test',
    },
    isFirstIteration: overrides?.isFirstIteration ?? true,
    turnToolCalls: overrides?.turnToolCalls ?? [],
  };
}

describe('createBuildBrowserInstructions', () => {
  it('first iteration includes 本回合策略 block', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput({ isFirstIteration: true }));
    expect(output).toContain('[本回合策略');
    expect(output).not.toContain('[后续迭代提醒]');
  });

  it('subsequent iteration includes 后续迭代提醒 block, not 本回合策略', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput({ isFirstIteration: false }));
    expect(output).toContain('[后续迭代提醒]');
    expect(output).not.toContain('[本回合策略');
  });

  it('system source type includes 系统触发说明 block', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput({ sourceType: 'system' }));
    expect(output).toContain('[系统触发说明]');
  });

  it('web source type does not include 系统触发说明 block', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput({ sourceType: 'web' }));
    expect(output).not.toContain('[系统触发说明]');
  });

  it('empty tool calls includes (无) and no-pretend warning', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput({ turnToolCalls: [] }));
    expect(output).toContain('(无)');
    expect(output).toContain('没有真正执行过');
  });

  it('non-empty tool calls shows numbered list and verification prompt', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(
      makeInput({
        turnToolCalls: [{ name: 'adjust_strength', argsJson: '{"channel":"A","delta":5}' }],
      }),
    );
    expect(output).toContain('1. adjust_strength(');
    expect(output).toContain('声称已经完成的动作');
  });

  it('device status block shows effectiveCap = min(limitA, maxStrengthA)', () => {
    const build = createBuildBrowserInstructions(makeSettings({ maxStrengthA: 80 }));
    const deviceState = { ...createEmptyDeviceState(), connected: true, limitA: 150 };
    const output = build(makeInput({ deviceState }));
    // effectiveCapA = min(150, 80) = 80
    expect(output).toContain('80');
  });

  it('device status block shows min of limitA when limitA is smaller', () => {
    const build = createBuildBrowserInstructions(makeSettings({ maxStrengthA: 200 }));
    const deviceState = { ...createEmptyDeviceState(), connected: true, limitA: 120 };
    const output = build(makeInput({ deviceState }));
    // effectiveCapA = min(120, 200) = 120
    expect(output).toContain('120');
  });
});
