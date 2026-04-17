import { describe, expect, it } from 'vitest';
import type { DevicePort, LlmPort, PermissionPort, SessionStorePort } from '@dg-agent/contracts';
import { AgentRuntime } from './agent-runtime.js';
import {
  createEmptyDeviceState,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type RuntimeEvent,
} from '@dg-agent/core';
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
      const nextStrength =
        command.channel === 'A'
          ? Math.max(0, this.state.strengthA + command.delta)
          : Math.max(0, this.state.strengthB + command.delta);
      this.state =
        command.channel === 'A'
          ? {
              ...this.state,
              strengthA: nextStrength,
            }
          : {
              ...this.state,
              strengthB: nextStrength,
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
  async runTurn() {
    return {
      assistantMessage: '准备启动 A',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'start',
          args: {
            channel: 'A',
            strength: 50,
            waveformId: 'pulse',
            loop: true,
          },
        },
      ],
    };
  }
}

class TwoStepLlm implements LlmPort {
  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (!hasToolOutput) {
      return {
        assistantMessage: '准备启动 A',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'start',
            args: {
              channel: 'A',
              strength: 30,
              waveformId: 'pulse',
              loop: true,
            },
          },
        ],
      };
    }

    return {
      assistantMessage: 'A 通道已经启动完毕。',
    };
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

class AbortableLlm implements LlmPort {
  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    input.onTextDelta?.('thinking');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 1_000);
      input.abortSignal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        },
        { once: true },
      );
    });

    return {
      assistantMessage: 'done',
    };
  }
}

class FailingLlm implements LlmPort {
  async runTurn(): Promise<never> {
    throw new Error('Provider HTTP error 401: unauthorized');
  }
}

class TestPermission implements PermissionPort {
  async request() {
    return { type: 'approve-once' } as const;
  }
}

class TestSessionStore implements SessionStorePort {
  constructor(private readonly sessions = new Map<string, ReturnType<TestSessionStore['cloneSession']>>()) {}

  async get(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneSession(session) : null;
  }

  async save(session: Awaited<ReturnType<TestSessionStore['get']>> extends infer T ? Exclude<T, null> : never) {
    this.sessions.set(session.id, this.cloneSession(session));
  }

  async list() {
    return Array.from(this.sessions.values()).map((session) => this.cloneSession(session));
  }

  async delete(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  private cloneSession(session: {
    id: string;
    createdAt: number;
    updatedAt: number;
    messages: Array<{ id: string; role: 'system' | 'user' | 'assistant'; content: string; createdAt: number }>;
    deviceState: DeviceState;
  }) {
    return {
      ...session,
      messages: session.messages.map((message) => ({ ...message })),
      deviceState: { ...session.deviceState },
    };
  }
}

describe('AgentRuntime', () => {
  it('runs tool iterations until a final assistant answer is produced', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TwoStepLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '启动A',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-loop',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.messages.at(-1)?.content).toContain('启动完毕');
    expect(session.deviceState.strengthA).toBe(10);
  });

  it('clamps cold start strength before executing device command', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
      },
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
    expect(session.deviceState.strengthA).toBe(10);
  });

  it('aborts an in-flight assistant reply and records the abort note', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new AbortableLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => {
      events.push(event);
    });

    const sendPromise = runtime.sendUserMessage({
      sessionId: 'test',
      text: 'stop this later',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-abort',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.abortCurrentReply('test');

    await expect(sendPromise).rejects.toThrow('Assistant reply aborted.');

    const session = await runtime.getSessionSnapshot('test');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]?.content).toContain('已手动中止');
    expect(events.some((event) => event.type === 'assistant-message-aborted')).toBe(true);
  });

  it('persists a friendly assistant error message when the provider fails', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new FailingLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'hello',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-error',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1]?.role).toBe('assistant');
    expect(session.messages[1]?.content).toContain('API Key');
  });

  it('refreshes persisted session device state from the real device on snapshot load', async () => {
    const now = Date.now();
    const sessionStore = new TestSessionStore(
      new Map([
        [
          'test',
          {
            id: 'test',
            createdAt: now,
            updatedAt: now,
            messages: [],
            deviceState: {
              ...createEmptyDeviceState(),
              connected: true,
              deviceName: 'Old Device',
            },
          },
        ],
      ]),
    );

    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false, deviceName: undefined }),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      sessionStore,
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.connected).toBe(false);
    expect(session.deviceState.deviceName).toBeUndefined();
  });

  it('enforces configurable per-turn adjust_strength quotas', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse' }),
      llm: new RepeatedAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        maxAdjustStrengthCallsPerTurn: 1,
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '继续加一点',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-quota',
      },
    });

    const denied = events.filter((event) => event.type === 'tool-call-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0] && 'reason' in denied[0] ? denied[0].reason : '').toContain('adjust_strength');
  });

  it('blocks burst on inactive channels when configured', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: true,
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'burst',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-burst-block',
      },
    });

    expect(events.some((event) => event.type === 'device-command-executed' && event.command.type === 'burst')).toBe(false);
    const denied = events.find((event) => event.type === 'tool-call-denied');
    expect(denied && 'reason' in denied ? denied.reason : '').toContain('already active channel');
  });

  it('allows burst on inactive channels when the tool-call config disables that guard', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'burst',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-burst-allow',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.strengthA).toBe(40);
  });
});
