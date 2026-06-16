import { describe, expect, it } from 'vitest';
import { createEmptyDeviceState } from '@dg-agent/core';
import { buildRuntimeContextPayload } from './runtime-context-tool.js';

describe('buildRuntimeContextPayload', () => {
  it('includes device caps and turn tool calls', () => {
    const payload = buildRuntimeContextPayload({
      session: {
        id: 's1',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        deviceState: {
          ...createEmptyDeviceState(),
          connected: true,
          limitA: 150,
          strengthA: 12,
          waveActiveA: true,
          currentWaveA: 'pulse_mid',
        },
      },
      context: { sessionId: 's1', sourceType: 'web', traceId: 't1' },
      turnToolCalls: [{ name: 'start', argsJson: '{"channel":"A"}' }],
      isFirstIteration: true,
      settings: { maxStrengthA: 80, maxStrengthB: 100 },
    });

    expect(payload.device).toMatchObject({
      channelA: {
        strength: 12,
        effectiveCap: 80,
        waveActive: true,
        currentWave: 'pulse_mid',
      },
    });
    expect(payload.turnToolCalls).toEqual([{ index: 1, name: 'start', args: '{"channel":"A"}' }]);
    expect(payload.strategy).toBe('first_iteration');
  });

  it('switches strategy hint on follow-up iterations', () => {
    const payload = buildRuntimeContextPayload({
      session: {
        id: 's1',
        createdAt: 0,
        updatedAt: 0,
        messages: [],
        deviceState: createEmptyDeviceState(),
      },
      context: { sessionId: 's1', sourceType: 'web', traceId: 't1' },
      turnToolCalls: [],
      isFirstIteration: false,
      settings: { maxStrengthA: 100, maxStrengthB: 100 },
    });

    expect(payload.strategy).toBe('follow_up');
    expect(String(payload.strategyHint)).toContain('后续迭代');
  });
});
