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
            waveformId: 'pulse_mid',
            loop: true,
          },
        },
      ],
    };
  }
}

class CountingDeviceToolLlm implements LlmPort {
  count = 0;

  async runTurn() {
    this.count += 1;
    return {
      assistantMessage: '准备启动 A',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'start',
          args: {
            channel: 'A',
            strength: 20,
            waveformId: 'pulse_mid',
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
              waveformId: 'pulse_mid',
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

class InspectingTwoStepLlm implements LlmPort {
  readonly conversations: Array<ReadonlyArray<NonNullable<Parameters<LlmPort['runTurn']>[0]['conversation']>[number]>> = [];

  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    this.conversations.push([...(input.conversation ?? [])]);

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
              waveformId: 'pulse_mid',
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

class ThrowingDevice extends TestDevice {
  override async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    if (command.type === 'start') {
      throw new Error('蓝牙写入失败。');
    }
    return super.execute(command);
  }
}

class DuplicateAssistantLlm implements LlmPort {
  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (!hasToolOutput) {
      return {
        assistantMessage: '先从很轻的强度开始。',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'start',
            args: {
              channel: 'A',
              strength: 10,
              waveformId: 'pulse_mid',
              loop: true,
            },
          },
        ],
      };
    }

    return {
      assistantMessage: '先从很轻的强度开始。',
    };
  }
}

class TimerFollowUpLlm implements LlmPort {
  readonly toolCountsBySource: Array<{ sourceType: string; toolCount: number }> = [];

  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    this.toolCountsBySource.push({
      sourceType: input.context.sourceType,
      toolCount: input.tools.length,
    });

    const hasToolOutput = input.conversation?.some((item) => item.kind === 'function_call_output');
    if (input.context.sourceType === 'system') {
      return {
        assistantMessage: '我还在等你的反馈。',
      };
    }

    if (!hasToolOutput) {
      return {
        assistantMessage: '我先等你反馈。',
        toolCalls: [
          {
            id: 'tool-timer',
            name: 'timer',
            args: { seconds: 1, label: '等待反馈' },
          },
        ],
      };
    }

    return {
      assistantMessage: '我先等你反馈。',
    };
  }
}

class DeniedToolFollowUpLlm implements LlmPort {
  readonly calls: Array<{ toolCount: number; message: string; syntheticDenySeen: boolean }> = [];

  async runTurn(input: Parameters<LlmPort['runTurn']>[0]) {
    const syntheticDenySeen = Boolean(
      input.conversation?.some(
        (item) =>
          item.kind === 'message' &&
          item.role === 'user' &&
          item.content.includes('[内部提醒] 刚才请求的工具'),
      ),
    );

    this.calls.push({
      toolCount: input.tools.length,
      message: input.message,
      syntheticDenySeen,
    });

    if (syntheticDenySeen || input.tools.length === 0) {
      return {
        assistantMessage: '这一步没有执行，因为你刚才拒绝了这次操作。',
      };
    }

    return {
      assistantMessage: '',
      toolCalls: [
        {
          id: 'tool-denied-1',
          name: 'start',
          args: {
            channel: 'A',
            strength: 10,
            waveformId: 'pulse_mid',
            loop: true,
          },
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

class DenyingPermission implements PermissionPort {
  async request() {
    return { type: 'deny', reason: '用户拒绝本次操作。' } as const;
  }
}

class TestSessionStore implements SessionStorePort {
  constructor(private readonly sessions = new Map<string, TestSessionStoreEntry>()) {}

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

  private cloneSession(session: TestSessionStoreEntry): TestSessionStoreEntry {
    return {
      ...session,
      messages: session.messages.map((message) => ({ ...message })),
      deviceState: { ...session.deviceState },
      metadata: session.metadata ? structuredClone(session.metadata) : undefined,
    };
  }
}

interface TestSessionStoreEntry {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{ id: string; role: 'system' | 'user' | 'assistant'; content: string; createdAt: number }>;
  deviceState: DeviceState;
  metadata?: Record<string, unknown>;
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
    expect(session.messages.some((message) => message.role === 'system')).toBe(false);
  });

  it('does not duplicate intermediate assistant narration in the next iteration context', async () => {
    const llm = new InspectingTwoStepLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '启动A',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-loop-no-dup',
      },
    });

    const nextIterationConversation = llm.conversations[1] ?? [];
    const narrations = nextIterationConversation.filter(
      (item) => item.kind === 'message' && item.role === 'assistant' && item.content === '准备启动 A',
    );

    expect(narrations).toHaveLength(1);
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

  it('does not recreate a deleted session when an in-flight reply is aborted during deletion', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new AbortableLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    const sendPromise = runtime.sendUserMessage({
      sessionId: 'deleted-while-busy',
      text: 'delete me later',
      context: {
        sessionId: 'deleted-while-busy',
        sourceType: 'cli',
        traceId: 'trace-delete-while-busy',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.deleteSession('deleted-while-busy');
    await expect(sendPromise).rejects.toThrow('Assistant reply aborted.');

    const sessions = await runtime.listSessions();
    expect(sessions.some((session) => session.id === 'deleted-while-busy')).toBe(false);
    expect(await runtime.getSessionTrace('deleted-while-busy')).toEqual([]);
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

  it('stops the turn immediately when a device tool is requested while disconnected', async () => {
    const llm = new CountingDeviceToolLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '启动 A 通道',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-disconnected-stop',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(llm.count).toBe(1);
    expect(session.messages.at(-1)?.content).toBe('设备未连接，请先点击“连接设备”。');
  });

  it('enforces configurable per-turn adjust_strength quotas', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
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

  it('uses ephemeral timer triggers, keeps them out of history, and disables tools on system turns', async () => {
    const llm = new TimerFollowUpLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    const followUpCompleted = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type !== 'assistant-message-completed') return;
        if (event.message.content !== '我还在等你的反馈。') return;
        unsubscribe();
        resolve();
      });
    });

    await runtime.sendUserMessage({
      sessionId: 'timer-test',
      text: '等我反馈',
      context: {
        sessionId: 'timer-test',
        sourceType: 'cli',
        traceId: 'trace-timer',
      },
    });

    await followUpCompleted;

    const session = await runtime.getSessionSnapshot('timer-test');
    const traceEntries = await runtime.getSessionTrace('timer-test');
    expect(session.messages.map((message) => message.content)).toEqual(['等我反馈', '我先等你反馈。', '我还在等你的反馈。']);
    expect(session.messages.some((message) => message.content.includes('[Timer due]'))).toBe(false);
    expect(session.messages.some((message) => message.content.includes('[内部提醒]'))).toBe(false);
    expect(traceEntries.some((entry) => entry.kind === 'timer-scheduled')).toBe(true);
    expect(traceEntries.some((entry) => entry.kind === 'timer-fired')).toBe(true);
    expect(llm.toolCountsBySource.some((entry) => entry.sourceType === 'system' && entry.toolCount === 0)).toBe(true);
  });

  it('does not persist the same assistant narration twice across a tool iteration and final reply', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new DuplicateAssistantLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'duplicate-assistant',
      text: '轻一点开始',
      context: {
        sessionId: 'duplicate-assistant',
        sourceType: 'cli',
        traceId: 'trace-duplicate-assistant',
      },
    });

    const session = await runtime.getSessionSnapshot('duplicate-assistant');
    expect(session.messages.filter((message) => message.role === 'assistant' && message.content === '先从很轻的强度开始。')).toHaveLength(1);
  });

  it('uses an ephemeral deny trigger to get a final assistant reply without persisting the trigger text', async () => {
    const llm = new DeniedToolFollowUpLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new DenyingPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'denied-follow-up',
      text: '启动 A',
      context: {
        sessionId: 'denied-follow-up',
        sourceType: 'cli',
        traceId: 'trace-denied-follow-up',
      },
    });

    const session = await runtime.getSessionSnapshot('denied-follow-up');
    const traceEntries = await runtime.getSessionTrace('denied-follow-up');

    expect(session.messages.map((message) => message.content)).toEqual([
      '启动 A',
      '这一步没有执行，因为你刚才拒绝了这次操作。',
    ]);
    expect(session.messages.some((message) => message.content.includes('[内部提醒]'))).toBe(false);
    expect(traceEntries.some((entry) => entry.kind === 'tool-denied')).toBe(true);
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.toolCount).toBe(0);
    expect(llm.calls[1]?.syntheticDenySeen).toBe(true);
  });

  it('persists a system notice when tool execution fails after approval', async () => {
    const llm = new DeniedToolFollowUpLlm();
    const runtime = new AgentRuntime({
      device: new ThrowingDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'failed-follow-up',
      text: '启动 A',
      context: {
        sessionId: 'failed-follow-up',
        sourceType: 'cli',
        traceId: 'trace-failed-follow-up',
      },
    });

    const session = await runtime.getSessionSnapshot('failed-follow-up');
    const traceEntries = await runtime.getSessionTrace('failed-follow-up');

    expect(session.messages.map((message) => message.content)).toEqual([
      '启动 A',
      '这一步没有执行，因为你刚才拒绝了这次操作。',
    ]);
    expect(session.messages.some((message) => message.content.includes('[内部提醒]'))).toBe(false);
    expect(traceEntries.some((entry) => entry.kind === 'tool-failed')).toBe(true);
    expect(llm.calls[1]?.toolCount).toBe(0);
    expect(llm.calls[1]?.syntheticDenySeen).toBe(true);
  });

  it('normalizes legacy timer trigger messages away and collapses assistant duplicates they caused', async () => {
    const now = Date.now();
    const sessionStore = new TestSessionStore(
      new Map([
        [
          'legacy-session',
          {
            id: 'legacy-session',
            createdAt: now,
            updatedAt: now,
            messages: [
              { id: 'u1', role: 'user', content: '继续', createdAt: now },
              { id: 'a1', role: 'assistant', content: '我先等你反馈。', createdAt: now + 1 },
              { id: 't1', role: 'user', content: '[Timer due]\nlabel: 等待反馈\nseconds: 5', createdAt: now + 2 },
              { id: 'a2', role: 'assistant', content: '我先等你反馈。', createdAt: now + 3 },
            ],
            deviceState: createEmptyDeviceState(),
          },
        ],
      ]),
    );

    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      sessionStore,
    });

    const session = await runtime.getSessionSnapshot('legacy-session');
    expect(session.messages.filter((message) => message.role === 'assistant' && message.content === '我先等你反馈。')).toHaveLength(1);
    expect(session.messages.some((message) => message.content.includes('定时提醒：等待反馈'))).toBe(false);
    expect(session.messages.some((message) => message.content.includes('[Timer due]'))).toBe(false);
  });
});
