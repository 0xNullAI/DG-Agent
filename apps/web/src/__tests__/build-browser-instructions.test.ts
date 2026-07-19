import { describe, expect, it } from 'vitest';
import {
  createEmptyDeviceState,
  type ActionContext,
  type ConversationMessage,
  type SessionSnapshot,
  type SourceType,
} from '@dg-agent/core';
import type { TurnToolCallSummary } from '@dg-agent/runtime';
import {
  createBuildBrowserInstructions,
  type BrowserInstructionSettings,
} from '@dg-agent/agent-browser';

function makeSettings(overrides?: Partial<BrowserInstructionSettings>): BrowserInstructionSettings {
  return {
    promptPresetId: 'gentle',
    savedPromptPresets: [],
    maxStrengthA: 100,
    maxStrengthB: 100,
    ...overrides,
  };
}

function makeInput(overrides?: {
  isFirstIteration?: boolean;
  sourceType?: SourceType;
  turnToolCalls?: TurnToolCallSummary[];
  deviceState?: ReturnType<typeof createEmptyDeviceState>;
}) {
  const deviceState = overrides?.deviceState ?? { ...createEmptyDeviceState(), connected: true };
  const session: SessionSnapshot = {
    id: 'test',
    createdAt: 0,
    updatedAt: 0,
    messages: [] as ConversationMessage[],
    deviceState,
  };
  const context: ActionContext = {
    sessionId: 'test',
    sourceType: overrides?.sourceType ?? 'web',
    traceId: 'trace-test',
  };
  return {
    session,
    context,
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
        turnToolCalls: [{ name: 'shock_adjust', argsJson: '{"channel":"A","delta":5}' }],
      }),
    );
    expect(output).toContain('1. shock_adjust(');
    expect(output).toContain('声称已经完成的动作');
  });

  it('always includes 剧情与设备的映射 block regardless of preset', () => {
    const build = createBuildBrowserInstructions(makeSettings({ promptPresetId: 'gentle' }));
    const output = build(makeInput());
    expect(output).toContain('[剧情与设备的映射]');
  });

  it('includes 剧情与设备的映射 block for custom saved presets too', () => {
    const build = createBuildBrowserInstructions(
      makeSettings({
        promptPresetId: 'custom-1',
        savedPromptPresets: [{ id: 'custom-1', name: 'My Custom', prompt: 'custom prompt' }],
      }),
    );
    const output = build(makeInput());
    expect(output).toContain('custom prompt');
    expect(output).toContain('[剧情与设备的映射]');
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
