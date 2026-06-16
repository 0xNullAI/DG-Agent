import { describe, expect, it } from 'vitest';
import type { ActionContext, SourceType } from '@dg-agent/core';
import {
  createBuildBrowserInstructions,
  type BrowserInstructionSettings,
} from '@dg-agent/agent-browser';

function makeSettings(overrides?: Partial<BrowserInstructionSettings>): BrowserInstructionSettings {
  return {
    promptPresetId: 'gentle',
    savedPromptPresets: [],
    ...overrides,
  };
}

function makeInput(sourceType: SourceType = 'web') {
  const context: ActionContext = {
    sessionId: 'test',
    sourceType,
    traceId: 'trace-test',
  };
  return { context };
}

describe('createBuildBrowserInstructions', () => {
  it('returns the same static prompt regardless of iteration', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const first = build(makeInput());
    const second = build(makeInput());
    expect(first).toBe(second);
    expect(first).not.toContain('[当前设备状态]');
    expect(first).not.toContain('[本回合已调用工具]');
    expect(first).not.toContain('[本回合策略');
    expect(first).not.toContain('[后续迭代提醒]');
  });

  it('system source type includes 系统触发说明 block', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput('system'));
    expect(output).toContain('[系统触发说明]');
  });

  it('web source type does not include 系统触发说明 block', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput('web'));
    expect(output).not.toContain('[系统触发说明]');
  });

  it('documents get_runtime_context instead of embedding live device state', () => {
    const build = createBuildBrowserInstructions(makeSettings());
    const output = build(makeInput());
    expect(output).toContain('[运行上下文工具]');
    expect(output).toContain('get_runtime_context');
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
});
