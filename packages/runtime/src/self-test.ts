import assert from 'node:assert/strict';
import type { DevicePort, LlmPort, PermissionPort } from '@dg-agent/contracts';
import { createEmptyDeviceState, type DeviceCommand, type DeviceCommandResult, type DeviceState, type RuntimeEvent } from '@dg-agent/core';
import { AgentRuntime } from './agent-runtime.js';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms-basic';

class TestDevice implements DevicePort {
  private state: DeviceState;
  private listeners = new Set<(state: DeviceState) => void>();

  constructor(initialState: Partial<DeviceState> = {}) {
    this.state = { ...createEmptyDeviceState(), connected: true, ...initialState };
  }

  async connect(): Promise<void> {
    this.state = { ...this.state, connected: true };
  }

  async disconnect(): Promise<void> {
    this.state = createEmptyDeviceState();
  }

  async getState(): Promise<DeviceState> {
    return this.state;
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    if (command.type === 'start' && command.channel === 'A') {
      this.state = {
        ...this.state,
        strengthA: command.strength,
        waveActiveA: true,
        currentWaveA: command.waveform.id,
      };
      this.emit();
    }

    if (command.type === 'adjustStrength') {
      this.state =
        command.channel === 'A'
          ? {
              ...this.state,
              strengthA: Math.max(0, this.state.strengthA + command.delta),
            }
          : {
              ...this.state,
              strengthB: Math.max(0, this.state.strengthB + command.delta),
            };
      this.emit();
    }

    if (command.type === 'burst') {
      this.state =
        command.channel === 'A'
          ? {
              ...this.state,
              strengthA: command.strength,
            }
          : {
              ...this.state,
              strengthB: command.strength,
            };
      this.emit();
    }

    return { state: this.state };
  }

  async emergencyStop(): Promise<void> {
    this.state = {
      ...this.state,
      strengthA: 0,
      strengthB: 0,
      waveActiveA: false,
      waveActiveB: false,
      currentWaveA: undefined,
      currentWaveB: undefined,
    };
    this.emit();
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

class TestLlm implements LlmPort {
  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (hasToolOutput) {
      return {
        assistantMessage: 'A 通道已经启动完毕。',
      };
    }

    return {
      assistantMessage: '准备启动 A',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'start',
          args: {
            channel: 'A',
            strength: 50,
            waveformId: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

class InspectingTestLlm implements LlmPort {
  readonly conversations: Array<ReadonlyArray<NonNullable<Parameters<LlmPort['runTurn']>[0]['conversation']>[number]>> = [];

  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    this.conversations.push([...(input.conversation ?? [])]);

    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (hasToolOutput) {
      return {
        assistantMessage: 'A 通道已经启动完毕。',
      };
    }

    return {
      assistantMessage: '准备启动 A',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'start',
          args: {
            channel: 'A',
            strength: 50,
            waveformId: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

class TestPermission implements PermissionPort {
  async request(_input: Parameters<PermissionPort['request']>[0]) {
    return { type: 'approve-once' } as const;
  }
}

class RepeatedAdjustLlm implements LlmPort {
  async runTurn() {
    return {
      assistantMessage: '连续调整强度',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'adjust_strength',
          args: { channel: 'A', delta: 5 },
        },
        {
          id: 'tool-2',
          name: 'adjust_strength',
          args: { channel: 'A', delta: 5 },
        },
      ],
    };
  }
}

class BurstOnlyLlm implements LlmPort {
  async runTurn() {
    return {
      assistantMessage: '尝试 burst',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'burst',
          args: { channel: 'A', strength: 40, durationMs: 1000 },
        },
      ],
    };
  }
}

class LegacyStartArgsLlm implements LlmPort {
  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (hasToolOutput) {
      return {
        assistantMessage: '老参数启动完成。',
      };
    }

    return {
      assistantMessage: '使用老参数启动',
      toolCalls: [
        {
          id: 'tool-legacy-start',
          name: 'start',
          args: {
            channel: 'A',
            strength: 8,
            waveform: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

class LegacyBurstArgsLlm implements LlmPort {
  async runTurn() {
    return {
      assistantMessage: '使用老参数 burst',
      toolCalls: [
        {
          id: 'tool-legacy-burst',
          name: 'burst',
          args: { channel: 'A', strength: 35, duration_ms: 800 },
        },
      ],
    };
  }
}

async function main(): Promise<void> {
  const runtime = new AgentRuntime({
    device: new TestDevice(),
    llm: new TestLlm(),
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
  });

  await runtime.sendUserMessage({
    sessionId: 'test',
    text: '启动A强度50',
    context: {
      sessionId: 'test',
      sourceType: 'cli',
      traceId: 'trace-1',
    },
  });

  const session = await runtime.getSessionSnapshot('test');
  assert.equal(session.deviceState.strengthA, 10);
  assert.equal(session.messages.length, 3);
  assert.equal(session.messages[1]?.content, '准备启动 A');
  assert.equal(session.messages.at(-1)?.content, 'A 通道已经启动完毕。');

  const inspectingLlm = new InspectingTestLlm();
  const inspectRuntime = new AgentRuntime({
    device: new TestDevice(),
    llm: inspectingLlm,
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
  });
  await inspectRuntime.sendUserMessage({
    sessionId: 'inspect',
    text: '启动A强度50',
    context: {
      sessionId: 'inspect',
      sourceType: 'cli',
      traceId: 'trace-inspect',
    },
  });
  const duplicatedNarrations =
    inspectingLlm.conversations[1]?.filter(
      (item) => item.kind === 'message' && item.role === 'assistant' && item.content === '准备启动 A',
    ) ?? [];
  assert.equal(duplicatedNarrations.length, 1);

  const quotaEvents: RuntimeEvent[] = [];
  const quotaRuntime = new AgentRuntime({
    device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
    llm: new RepeatedAdjustLlm(),
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    toolCallConfig: {
      maxToolIterations: 1,
      maxAdjustStrengthCallsPerTurn: 1,
    },
  });
  quotaRuntime.subscribe((event) => {
    quotaEvents.push(event);
  });
  await quotaRuntime.sendUserMessage({
    sessionId: 'quota',
    text: '继续加一点',
    context: {
      sessionId: 'quota',
      sourceType: 'cli',
      traceId: 'trace-quota',
    },
  });
  assert.equal(quotaEvents.filter((event) => event.type === 'tool-call-denied').length, 1);

  const burstDeniedEvents: RuntimeEvent[] = [];
  const burstDeniedRuntime = new AgentRuntime({
    device: new TestDevice(),
    llm: new BurstOnlyLlm(),
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    toolCallConfig: {
      maxToolIterations: 1,
      burstRequiresActiveChannel: true,
    },
  });
  burstDeniedRuntime.subscribe((event) => {
    burstDeniedEvents.push(event);
  });
  await burstDeniedRuntime.sendUserMessage({
    sessionId: 'burst-denied',
    text: 'burst',
    context: {
      sessionId: 'burst-denied',
      sourceType: 'cli',
      traceId: 'trace-burst-denied',
    },
  });
  assert.equal(
    burstDeniedEvents.some((event) => event.type === 'device-command-executed' && event.command.type === 'burst'),
    false,
  );

  const burstAllowedRuntime = new AgentRuntime({
    device: new TestDevice(),
    llm: new BurstOnlyLlm(),
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    toolCallConfig: {
      maxToolIterations: 1,
      burstRequiresActiveChannel: false,
    },
  });
  await burstAllowedRuntime.sendUserMessage({
    sessionId: 'burst-allowed',
    text: 'burst',
    context: {
      sessionId: 'burst-allowed',
      sourceType: 'cli',
      traceId: 'trace-burst-allowed',
    },
  });
  const burstAllowedSession = await burstAllowedRuntime.getSessionSnapshot('burst-allowed');
  assert.equal(burstAllowedSession.deviceState.strengthA, 40);

  const legacyStartRuntime = new AgentRuntime({
    device: new TestDevice(),
    llm: new LegacyStartArgsLlm(),
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
  });
  await legacyStartRuntime.sendUserMessage({
    sessionId: 'legacy-start',
    text: '用老参数启动',
    context: {
      sessionId: 'legacy-start',
      sourceType: 'cli',
      traceId: 'trace-legacy-start',
    },
  });
  const legacyStartSession = await legacyStartRuntime.getSessionSnapshot('legacy-start');
  assert.equal(legacyStartSession.deviceState.currentWaveA, 'pulse_mid');
  assert.equal(legacyStartSession.deviceState.strengthA, 8);

  const legacyBurstRuntime = new AgentRuntime({
    device: new TestDevice({ strengthA: 12, waveActiveA: true, currentWaveA: 'pulse_mid' }),
    llm: new LegacyBurstArgsLlm(),
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    toolCallConfig: {
      maxToolIterations: 1,
      burstRequiresActiveChannel: false,
    },
  });
  await legacyBurstRuntime.sendUserMessage({
    sessionId: 'legacy-burst',
    text: '用老参数 burst',
    context: {
      sessionId: 'legacy-burst',
      sourceType: 'cli',
      traceId: 'trace-legacy-burst',
    },
  });
  const legacyBurstSession = await legacyBurstRuntime.getSessionSnapshot('legacy-burst');
  assert.equal(legacyBurstSession.deviceState.strengthA, 35);

  console.log('runtime self-test passed');
}

void main();
