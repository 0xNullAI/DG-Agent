import type { ActionContext, SessionSnapshot } from '@dg-agent/core';
import { getAnyPromptPresetById, type SavedPromptPreset } from '@dg-agent/prompts-basic';
import type { TurnToolCallSummary } from '@dg-agent/runtime';

export interface BrowserInstructionSettings {
  promptPresetId: string;
  customPrompt: string;
  savedPromptPresets: SavedPromptPreset[];
  maxStrengthA: number;
  maxStrengthB: number;
}

export function createBuildBrowserInstructions(settings: BrowserInstructionSettings) {
  return (input: {
    session: SessionSnapshot;
    context: ActionContext;
    isFirstIteration: boolean;
    turnToolCalls: readonly TurnToolCallSummary[];
  }): string => {
    const selectedPreset = getAnyPromptPresetById(settings.promptPresetId, settings.savedPromptPresets);
    const customPrompt = settings.customPrompt.trim();
    const executedToolSummary =
      input.turnToolCalls.length > 0
        ? `Tools already executed this turn: ${input.turnToolCalls.map((call) => `${call.name}(${call.argsJson})`).join(', ')}. Do not repeat them unless the previous result clearly requires a correction step.`
        : '';
    const deviceStatusBlock = buildDeviceStatusBlock(input.session, settings);
    const firstIterationReminder = input.isFirstIteration
      ? 'This is the first iteration of the current turn. Decide carefully whether tools are actually needed before making any claim about device state changes.'
      : 'This is a follow-up iteration after at least one tool call. Use the returned tool outputs and current device state to conclude instead of restarting the plan.';

    return [
      'You are DG-Agent, a browser-hosted assistant that may control a physical device.',
      'Be conservative and safety-first.',
      'Use tools only when necessary.',
      'Never claim a tool succeeded if it was denied or failed.',
      selectedPreset ? `Active scene: ${selectedPreset.name}. ${selectedPreset.prompt}` : '',
      customPrompt ? `Custom behavior override: ${customPrompt}` : '',
      `Source type: ${input.context.sourceType}.`,
      `Session id: ${input.session.id}.`,
      deviceStatusBlock,
      firstIterationReminder,
      executedToolSummary,
    ]
      .filter(Boolean)
      .join(' ');
  };
}

function buildDeviceStatusBlock(session: SessionSnapshot, settings: Pick<BrowserInstructionSettings, 'maxStrengthA' | 'maxStrengthB'>): string {
  const device = session.deviceState;
  const effectiveCapA = Math.min(device.limitA, settings.maxStrengthA);
  const effectiveCapB = Math.min(device.limitB, settings.maxStrengthB);
  const battery = typeof device.battery === 'number' ? `${device.battery}%` : 'unknown';
  const connection = device.connected ? `connected${device.deviceName ? ` (${device.deviceName})` : ''}` : 'disconnected';

  return [
    'Current device state:',
    `connection=${connection}`,
    `battery=${battery}`,
    `channelA=strength:${device.strengthA}, cap:${effectiveCapA}, wave:${device.waveActiveA ? 'active' : 'stopped'}, waveform:${device.currentWaveA ?? '-'}`,
    `channelB=strength:${device.strengthB}, cap:${effectiveCapB}, wave:${device.waveActiveB ? 'active' : 'stopped'}, waveform:${device.currentWaveB ?? '-'}`,
  ].join(' ');
}
