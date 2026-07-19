import { describe, expect, it } from 'vitest';
import type { DeviceClient, LlmClient, PermissionService, SessionStore } from '@dg-agent/core';
import { AgentRuntime } from './agent-runtime.js';
import { createDefaultPolicyRules } from './default-policies.js';
import { PolicyEngine } from './policy-engine.js';
import {
  createMessage,
  createEmptyDeviceState,
  getBridgeOriginMetadata,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type ModelContextStrategy,
  type OpossumCommand,
  type RuntimeEvent,
} from '@dg-agent/core';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import type {
  CivetPressureReading,
  OpossumState,
  PawPrintsReading,
  SensorState,
} from '@dg-kit/protocol';
import type {
  CivetEdgingClient,
  OpossumClient,
  OpossumCommandResult,
  PawPrintsClient,
} from './device-clients.js';

class TestDevice implements DeviceClient {
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

  get listenerCount(): number {
    return this.listeners.size;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}

class TestLlm implements LlmClient {
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

class CountingDeviceToolLlm implements LlmClient {
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

class TwoStepLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class InspectingTwoStepLlm implements LlmClient {
  readonly conversations: Array<
    ReadonlyArray<NonNullable<Parameters<LlmClient['runTurn']>[0]['conversation']>[number]>
  > = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class ContextProbeLlm implements LlmClient {
  readonly conversations: string[][] = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.conversations.push(
      (input.conversation ?? []).flatMap((item) =>
        item.kind === 'message' ? [`${item.role}:${item.content}`] : [],
      ),
    );

    return {
      assistantMessage: 'ok',
    };
  }
}

class RepeatedAdjustLlm implements LlmClient {
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

class LargeAdjustLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '澶у箙璋冩暣寮哄害',
      toolCalls: [
        {
          id: 'tool-large-adjust',
          name: 'adjust_strength',
          args: { channel: 'A', delta: 25 },
        },
      ],
    };
  }
}

class LargeStartLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '灏濊瘯鍐峰惎鍔ㄩ珮寮哄害',
      toolCalls: [
        {
          id: 'tool-large-start',
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
}

class BurstOnlyLlm implements LlmClient {
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

class LongBurstLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '尝试长时间 burst',
      toolCalls: [
        {
          id: 'tool-long-burst',
          name: 'burst',
          args: { channel: 'A', strength: 40, durationMs: 3000 },
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

class DuplicateAssistantLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class TimerFollowUpLlm implements LlmClient {
  readonly toolCountsBySource: Array<{ sourceType: string; toolCount: number }> = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class DeniedToolFollowUpLlm implements LlmClient {
  readonly calls: Array<{ toolCount: number; message: string; syntheticDenySeen: boolean }> = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class AbortableLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class FailingLlm implements LlmClient {
  async runTurn(): Promise<never> {
    throw new Error('Provider HTTP error 401: unauthorized');
  }
}

class TestPermission implements PermissionService {
  async request() {
    return { type: 'approve-once' } as const;
  }
}

class DenyingPermission implements PermissionService {
  async request() {
    return { type: 'deny', reason: '用户拒绝本次操作' } as const;
  }
}

class CountingPermission implements PermissionService {
  callCount = 0;
  async request() {
    this.callCount += 1;
    return { type: 'approve-once' } as const;
  }
}

class TestSessionStore implements SessionStore {
  constructor(private readonly sessions = new Map<string, TestSessionStoreEntry>()) {}

  async get(sessionId: string) {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneSession(session) : null;
  }

  async save(
    session: Awaited<ReturnType<TestSessionStore['get']>> extends infer T
      ? Exclude<T, null>
      : never,
  ) {
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
  messages: Array<{
    id: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    createdAt: number;
  }>;
  deviceState: DeviceState;
  metadata?: Record<string, unknown>;
}

function createScriptedMessages(
  entries: Array<['user' | 'assistant', string]>,
  startedAt = Date.now(),
) {
  return entries.map(([role, content], index) => createMessage(role, content, startedAt + index));
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
      (item) =>
        item.kind === 'message' && item.role === 'assistant' && item.content === '准备启动 A',
    );

    expect(narrations).toHaveLength(1);
  });

  it('supports configurable model context strategies', async () => {
    const seededMessages = createScriptedMessages([
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
      ['assistant', 'a2'],
      ['user', 'u3'],
      ['assistant', 'a3'],
      ['user', 'u4'],
      ['assistant', 'a4'],
      ['user', 'u5'],
      ['assistant', 'a5'],
      ['user', 'u6'],
      ['assistant', 'a6'],
    ]);

    const cases: Array<{ strategy: ModelContextStrategy; expected: string[] }> = [
      {
        strategy: 'last-user-turn',
        expected: ['user:u6', 'assistant:a6', 'user:u7'],
      },
      {
        strategy: 'last-five-user-turns',
        expected: [
          'user:u3',
          'assistant:a3',
          'user:u4',
          'assistant:a4',
          'user:u5',
          'assistant:a5',
          'user:u6',
          'assistant:a6',
          'user:u7',
        ],
      },
      {
        strategy: 'full-history',
        expected: [
          'user:u1',
          'assistant:a1',
          'user:u2',
          'assistant:a2',
          'user:u3',
          'assistant:a3',
          'user:u4',
          'assistant:a4',
          'user:u5',
          'assistant:a5',
          'user:u6',
          'assistant:a6',
          'user:u7',
        ],
      },
    ];

    for (const testCase of cases) {
      const llm = new ContextProbeLlm();
      const now = Date.now();
      const sessionStore = new TestSessionStore(
        new Map([
          [
            `context-${testCase.strategy}`,
            {
              id: `context-${testCase.strategy}`,
              createdAt: now,
              updatedAt: now,
              messages: seededMessages.map((message) => ({ ...message })),
              deviceState: createEmptyDeviceState(),
            },
          ],
        ]),
      );

      const runtime = new AgentRuntime({
        device: new TestDevice(),
        llm,
        permission: new TestPermission(),
        waveformLibrary: createBasicWaveformLibrary(),
        sessionStore,
        modelContextStrategy: testCase.strategy,
      });

      await runtime.sendUserMessage({
        sessionId: `context-${testCase.strategy}`,
        text: 'u7',
        context: {
          sessionId: `context-${testCase.strategy}`,
          sourceType: 'cli',
          traceId: `trace-${testCase.strategy}`,
        },
      });

      expect(llm.conversations[0]).toEqual(testCase.expected);
    }
  });

  it('persists bridge origin metadata for bridge-sourced sessions', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'bridge-active-session',
      text: 'hello from group',
      context: {
        sessionId: 'bridge-active-session',
        sourceType: 'qq',
        sourceUserId: 'group:123456',
        sourceUserName: 'Test Group',
        traceId: 'trace-bridge-origin',
      },
    });

    const session = await runtime.getSessionSnapshot('bridge-active-session');
    expect(getBridgeOriginMetadata(session.metadata)).toEqual({
      platform: 'qq',
      userId: 'group:123456',
      userName: 'Test Group',
    });
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

    await expect(sendPromise).rejects.toThrow('已停止当前回复');

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
    await expect(sendPromise).rejects.toThrow('已停止当前回复');

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
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接郊狼。',
    );
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

  it('applies a configurable single-step adjust_strength cap', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LargeAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxAdjustStep: 15,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '鍔犲ぇ涓€鐐?',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-adjust-step-cap',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.strengthA).toBe(25);
  });

  it('applies a configurable cold-start strength cap to start', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new LargeStartLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxColdStartStrength: 12,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '鍚姩 A',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-cold-start-cap',
      },
    });

    const session = await runtime.getSessionSnapshot('test');
    expect(session.deviceState.strengthA).toBe(12);
  });

  it('still asks for permission after a clamp instead of silently executing the clamped command', async () => {
    // Issue #65: a clamp rule (here step-adjust, max ±10) used to short-
    // circuit the policy engine and skip past permission-gate. So an
    // "+12" adjust in "每次询问" mode would clamp to +10 and execute
    // without ever asking the user — and PR #76's clamp visibility was
    // only half the story.
    const permission = new CountingPermission();
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LargeAdjustLlm(),
      permission,
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxAdjustStep: 10,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'clamp-then-confirm',
      text: '调高一点',
      context: {
        sessionId: 'clamp-then-confirm',
        sourceType: 'cli',
        traceId: 'trace-clamp-confirm',
      },
    });

    // Permission was asked exactly once, even though step-adjust clamped.
    expect(permission.callCount).toBe(1);
    // Clamp event still fires with the original (+25) and adjusted (+10).
    const clamped = events.find((event) => event.type === 'tool-call-clamped');
    expect(clamped).toBeDefined();
    if (!clamped || clamped.type !== 'tool-call-clamped') throw new Error('expected clamp event');
    if (
      clamped.originalCommand.type === 'adjustStrength' &&
      clamped.adjustedCommand.type === 'adjustStrength'
    ) {
      expect(clamped.originalCommand.delta).toBe(25);
      expect(clamped.adjustedCommand.delta).toBe(10);
    }
    // And the device only moved by the clamped delta.
    const session = await runtime.getSessionSnapshot('clamp-then-confirm');
    expect(session.deviceState.strengthA).toBe(20);
  });

  it('rejects the call when permission is denied even after a clamp', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LargeAdjustLlm(),
      permission: new DenyingPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxAdjustStep: 10,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'clamp-then-deny',
      text: '调高一点',
      context: {
        sessionId: 'clamp-then-deny',
        sourceType: 'cli',
        traceId: 'trace-clamp-deny',
      },
    });

    expect(
      events.some(
        (event) =>
          event.type === 'device-command-executed' && event.command.type === 'adjustStrength',
      ),
    ).toBe(false);
    const denied = events.find((event) => event.type === 'tool-call-denied');
    expect(denied && 'reason' in denied ? denied.reason : '').toContain('拒绝');
    const session = await runtime.getSessionSnapshot('clamp-then-deny');
    expect(session.deviceState.strengthA).toBe(10);
  });

  it('emits tool-call-clamped with original and adjusted commands when policy clamps', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new LargeStartLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxColdStartStrength: 12,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'clamp-event',
      text: '启动 A',
      context: {
        sessionId: 'clamp-event',
        sourceType: 'cli',
        traceId: 'trace-clamp-event',
      },
    });

    const clamped = events.find((event) => event.type === 'tool-call-clamped');
    expect(clamped).toBeDefined();
    if (!clamped || clamped.type !== 'tool-call-clamped') throw new Error('expected clamp event');
    expect(clamped.originalCommand.type).toBe('start');
    expect(clamped.adjustedCommand.type).toBe('start');
    if (clamped.originalCommand.type !== 'start' || clamped.adjustedCommand.type !== 'start') {
      throw new Error('expected start commands');
    }
    expect(clamped.originalCommand.strength).toBe(30);
    expect(clamped.adjustedCommand.strength).toBe(12);
    expect(clamped.reason).toContain('冷启动');

    const executing = events.find(
      (event) =>
        event.type === 'tool-call-executing' &&
        event.command?.type === 'start' &&
        event.clampedFrom !== undefined,
    );
    expect(executing).toBeDefined();
  });

  it('feeds clamp details back to the LLM so it cannot ignore the adjustment', async () => {
    class CapturingLlm implements LlmClient {
      capturedToolOutput: string | null = null;
      private callCount = 0;
      async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
        this.callCount += 1;
        if (this.callCount === 1) {
          return {
            assistantMessage: '尝试启动',
            toolCalls: [
              {
                id: 'tool-clamp-feedback',
                name: 'start',
                args: { channel: 'A', strength: 30, waveformId: 'pulse_mid', loop: true },
              },
            ],
          };
        }
        const lastOutput = input.conversation
          ?.filter((item) => item.kind === 'function_call_output')
          .pop();
        if (lastOutput && 'output' in lastOutput && typeof lastOutput.output === 'string') {
          this.capturedToolOutput = lastOutput.output;
        }
        return { assistantMessage: '已按策略调整后启动。' };
      }
    }

    const llm = new CapturingLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(createDefaultPolicyRules({ maxColdStartStrength: 12 })),
      toolCallConfig: { maxToolIterations: 2 },
    });

    await runtime.sendUserMessage({
      sessionId: 'clamp-feedback',
      text: '启动 A',
      context: {
        sessionId: 'clamp-feedback',
        sourceType: 'cli',
        traceId: 'trace-clamp-feedback',
      },
    });

    expect(llm.capturedToolOutput).not.toBeNull();
    const parsed = JSON.parse(llm.capturedToolOutput ?? '{}');
    expect(parsed.ok).toBe('clamped');
    expect(parsed.clampedFrom).toBeDefined();
    expect(parsed.clampedFrom.strength).toBe(30);
    expect(parsed.command.strength).toBe(12);
    expect(parsed._warning).toContain('策略限制');
    expect(parsed.notes.some((note: string) => note.startsWith('policy-clamped:'))).toBe(true);
  });

  it('releases its device-state listener on dispose so multiple runtimes can share one device', async () => {
    const device = new TestDevice();
    expect(device.listenerCount).toBe(0);

    const first = new AgentRuntime({
      device,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    expect(device.listenerCount).toBe(1);

    const second = new AgentRuntime({
      device,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    expect(device.listenerCount).toBe(2);

    first.dispose();
    expect(device.listenerCount).toBe(1);

    second.dispose();
    expect(device.listenerCount).toBe(0);

    // Calling dispose twice is a no-op.
    first.dispose();
    expect(device.listenerCount).toBe(0);
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

    expect(
      events.some(
        (event) => event.type === 'device-command-executed' && event.command.type === 'burst',
      ),
    ).toBe(false);
    const denied = events.find((event) => event.type === 'tool-call-denied');
    expect(denied && 'reason' in denied ? denied.reason : '').toContain('还没有运行');
  });

  it('rejects every burst call when maxBurstCallsPerTurn is 0 ("disable bursts" opt-out)', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 20, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        maxBurstCallsPerTurn: 0,
        burstRequiresActiveChannel: false,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'burst-off',
      text: 'burst',
      context: {
        sessionId: 'burst-off',
        sourceType: 'cli',
        traceId: 'trace-burst-disabled',
      },
    });

    expect(
      events.some(
        (event) => event.type === 'device-command-executed' && event.command.type === 'burst',
      ),
    ).toBe(false);
    const denied = events.find((event) => event.type === 'tool-call-denied');
    expect(denied && 'reason' in denied ? denied.reason : '').toContain('已被用户在设置中关闭');
    // Strength must not have moved.
    const session = await runtime.getSessionSnapshot('burst-off');
    expect(session.deviceState.strengthA).toBe(20);
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

  it('clamps burst to the absolute strength cap when configured', async () => {
    // Issue #68: a burst-only absolute cap (here 30) must clamp burst.strength
    // even when the per-channel max (default 50) would allow more.
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(), // tries burst at strength 40
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxBurstStrengthAbsolute: 30,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'burst-abs-cap',
      text: 'burst',
      context: {
        sessionId: 'burst-abs-cap',
        sourceType: 'cli',
        traceId: 'trace-burst-abs',
      },
    });

    const session = await runtime.getSessionSnapshot('burst-abs-cap');
    expect(session.deviceState.strengthA).toBe(30);
  });

  it('clamps burst to current strength + relative cap', async () => {
    // current = 25, relative cap = 10 → burst can't exceed 35.
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 25, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(), // tries burst at strength 40
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxBurstStrengthRelative: 10,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'burst-rel-cap',
      text: 'burst',
      context: {
        sessionId: 'burst-rel-cap',
        sourceType: 'cli',
        traceId: 'trace-burst-rel',
      },
    });

    const session = await runtime.getSessionSnapshot('burst-rel-cap');
    expect(session.deviceState.strengthA).toBe(35);
  });

  it('takes the tighter of absolute and per-channel caps when both apply to a burst', async () => {
    // Channel cap 30, burst absolute cap 80, current strength 5.
    // The channel cap wins — burst can't exceed 30. Verifies that the
    // policy loop introduced by #65 lets channel-cap and burst-cap stack
    // instead of racing for "first clamp wins".
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 5, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new BurstOnlyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxStrengthA: 30,
          maxStrengthB: 30,
          maxBurstStrengthAbsolute: 80,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    await runtime.sendUserMessage({
      sessionId: 'burst-stacked-caps',
      text: 'burst',
      context: {
        sessionId: 'burst-stacked-caps',
        sourceType: 'cli',
        traceId: 'trace-burst-stack',
      },
    });

    const session = await runtime.getSessionSnapshot('burst-stacked-caps');
    expect(session.deviceState.strengthA).toBe(30);
  });

  it('applies a configurable burst duration cap', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 10, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LongBurstLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      policyEngine: new PolicyEngine(
        createDefaultPolicyRules({
          maxBurstDurationMs: 1200,
        }),
      ),
      toolCallConfig: {
        maxToolIterations: 1,
        burstRequiresActiveChannel: false,
      },
    });

    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: 'burst 久一点',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-burst-duration-cap',
      },
    });

    const executed = events.find(
      (
        event,
      ): event is Extract<RuntimeEvent, { type: 'device-command-executed' }> & {
        command: Extract<DeviceCommand, { type: 'burst' }>;
      } => event.type === 'device-command-executed' && event.command.type === 'burst',
    );
    expect(executed?.command.durationMs ?? null).toBe(1200);
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
    expect(session.messages.map((message) => message.content)).toEqual([
      '等我反馈',
      '我先等你反馈。',
      '我还在等你的反馈。',
    ]);
    expect(session.messages.some((message) => message.content.includes('[Timer due]'))).toBe(false);
    expect(session.messages.some((message) => message.content.includes('[内部提醒]'))).toBe(false);
    expect(traceEntries.some((entry) => entry.kind === 'timer-scheduled')).toBe(true);
    expect(traceEntries.some((entry) => entry.kind === 'timer-fired')).toBe(true);
    expect(
      llm.toolCountsBySource.some(
        (entry) => entry.sourceType === 'system' && entry.toolCount === 0,
      ),
    ).toBe(true);
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
    expect(
      session.messages.filter(
        (message) => message.role === 'assistant' && message.content === '先从很轻的强度开始。',
      ),
    ).toHaveLength(1);
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
              {
                id: 't1',
                role: 'user',
                content: '[Timer due]\nlabel: 等待反馈\nseconds: 5',
                createdAt: now + 2,
              },
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
    expect(
      session.messages.filter(
        (message) => message.role === 'assistant' && message.content === '我先等你反馈。',
      ),
    ).toHaveLength(1);
    expect(session.messages.some((message) => message.content.includes('定时提醒：等待反馈'))).toBe(
      false,
    );
    expect(session.messages.some((message) => message.content.includes('[Timer due]'))).toBe(false);
  });

  it('accepts legacy "waveform" arg name on the start tool', async () => {
    class LegacyStartArgsLlm implements LlmClient {
      async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
        const hasToolOutput = input.conversation?.some(
          (item) => item.kind === 'function_call_output',
        );
        return hasToolOutput
          ? { assistantMessage: '老参数启动完成。' }
          : {
              assistantMessage: '使用老参数启动',
              toolCalls: [
                {
                  id: 'tool-legacy-start',
                  name: 'start',
                  args: { channel: 'A', strength: 8, waveform: 'pulse_mid', loop: true },
                },
              ],
            };
      }
    }

    const runtime = new AgentRuntime({
      device: new TestDevice(),
      llm: new LegacyStartArgsLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });
    await runtime.sendUserMessage({
      sessionId: 'legacy-start',
      text: '用老参数启动',
      context: { sessionId: 'legacy-start', sourceType: 'cli', traceId: 'trace-legacy-start' },
    });
    const session = await runtime.getSessionSnapshot('legacy-start');
    expect(session.deviceState.currentWaveA).toBe('pulse_mid');
    expect(session.deviceState.strengthA).toBe(8);
  });

  it('accepts legacy "duration_ms" arg name on the burst tool', async () => {
    class LegacyBurstArgsLlm implements LlmClient {
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

    const runtime = new AgentRuntime({
      device: new TestDevice({ strengthA: 12, waveActiveA: true, currentWaveA: 'pulse_mid' }),
      llm: new LegacyBurstArgsLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1, burstRequiresActiveChannel: false },
    });
    await runtime.sendUserMessage({
      sessionId: 'legacy-burst',
      text: '用老参数 burst',
      context: { sessionId: 'legacy-burst', sourceType: 'cli', traceId: 'trace-legacy-burst' },
    });
    const session = await runtime.getSessionSnapshot('legacy-burst');
    expect(session.deviceState.strengthA).toBe(35);
  });
});

function createOpossumState(overrides: Partial<OpossumState> = {}): OpossumState {
  return { connected: true, battery: 100, intensityA: 0, intensityB: 0, ...overrides };
}

class TestOpossumClient implements OpossumClient {
  private state: OpossumState;
  ledCalls: number[] = [];

  constructor(initialState: Partial<OpossumState> = {}) {
    this.state = createOpossumState(initialState);
  }

  async connect(): Promise<void> {
    this.state = { ...this.state, connected: true };
  }
  async disconnect(): Promise<void> {
    this.state = createOpossumState({ connected: false });
  }
  async getState(): Promise<OpossumState> {
    return this.state;
  }
  async execute(command: OpossumCommand): Promise<OpossumCommandResult> {
    if (command.type === 'vibrateStart') {
      this.state =
        command.channel === 'A'
          ? { ...this.state, intensityA: command.intensity }
          : { ...this.state, intensityB: command.intensity };
    }
    if (command.type === 'vibrateAdjust') {
      const next =
        command.channel === 'A'
          ? Math.max(0, this.state.intensityA + command.delta)
          : Math.max(0, this.state.intensityB + command.delta);
      this.state =
        command.channel === 'A'
          ? { ...this.state, intensityA: next }
          : { ...this.state, intensityB: next };
    }
    if (command.type === 'vibrateStop') {
      this.state = command.channel
        ? command.channel === 'A'
          ? { ...this.state, intensityA: 0 }
          : { ...this.state, intensityB: 0 }
        : { ...this.state, intensityA: 0, intensityB: 0 };
    }
    return { state: this.state };
  }
  async emergencyStop(): Promise<void> {
    this.state = { ...this.state, intensityA: 0, intensityB: 0 };
  }
  async setIndicatorColor(color: number): Promise<void> {
    this.ledCalls.push(color);
  }
  onStateChanged(): () => void {
    return () => {};
  }
}

class TestPawPrintsClient implements PawPrintsClient {
  private state: SensorState;
  ledCalls: number[] = [];
  private readingListeners = new Set<(reading: PawPrintsReading) => void>();

  constructor(initialState: Partial<SensorState> = {}) {
    this.state = { connected: true, battery: 100, ...initialState };
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState(): Promise<SensorState> {
    return this.state;
  }
  subscribe(listener: (reading: PawPrintsReading) => void): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }
  onStateChanged(): () => void {
    return () => {};
  }
  async setIndicatorColor(color: number): Promise<void> {
    this.ledCalls.push(color);
  }
  /** Test hook: simulate a raw sensor reading reaching the SensorTriggerEngine. */
  pushReading(reading: PawPrintsReading): void {
    for (const listener of this.readingListeners) listener(reading);
  }
}

class TestCivetEdgingClient implements CivetEdgingClient {
  private state: SensorState;
  private readingListeners = new Set<(reading: CivetPressureReading) => void>();

  constructor(initialState: Partial<SensorState> = {}) {
    this.state = { connected: true, battery: 100, ...initialState };
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getState(): Promise<SensorState> {
    return this.state;
  }
  subscribe(listener: (reading: CivetPressureReading) => void): () => void {
    this.readingListeners.add(listener);
    return () => {
      this.readingListeners.delete(listener);
    };
  }
  onStateChanged(): () => void {
    return () => {};
  }
  /** Test hook: simulate a raw pressure reading reaching subscribers. */
  pushReading(reading: CivetPressureReading): void {
    for (const listener of this.readingListeners) listener(reading);
  }
  // Deliberately no setIndicatorColor override here in some tests to check
  // the "client exists but doesn't support LED" branch; individual test
  // classes add it where needed.
}

class OpossumVibrateStartLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '启动负鼠振动',
      toolCalls: [
        {
          id: 'tool-vibrate-1',
          name: 'vibrate_start',
          args: { channel: 'A', intensity: 30 },
        },
      ],
    };
  }
}

class OpossumVibrateAdjustLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '调整负鼠振动',
      toolCalls: [
        {
          id: 'tool-vibrate-adjust-1',
          name: 'vibrate_adjust',
          args: { channel: 'A', delta: 25 },
        },
      ],
    };
  }
}

class RepeatedVibrateAdjustLlm implements LlmClient {
  async runTurn() {
    return {
      assistantMessage: '连续调整负鼠振动',
      toolCalls: [
        {
          id: 'tool-vibrate-adjust-1',
          name: 'vibrate_adjust',
          args: { channel: 'A', delta: 5 },
        },
        {
          id: 'tool-vibrate-adjust-2',
          name: 'vibrate_adjust',
          args: { channel: 'A', delta: 5 },
        },
      ],
    };
  }
}

class SetIndicatorColorLlm implements LlmClient {
  constructor(private readonly deviceKind: string) {}
  async runTurn() {
    return {
      assistantMessage: '设置指示灯',
      toolCalls: [
        {
          id: 'tool-indicator-1',
          name: 'set_indicator_color',
          args: { deviceKind: this.deviceKind, color: 3 },
        },
      ],
    };
  }
}

describe('AgentRuntime multi-device (opossum / sensors)', () => {
  it('clamps opossum cold-start intensity to the default cap and dispatches through the opossum plan', async () => {
    const opossum = new TestOpossumClient();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      opossum,
      llm: new OpossumVibrateStartLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-cold-start',
      text: '启动负鼠 A 通道',
      context: { sessionId: 'opossum-cold-start', sourceType: 'cli', traceId: 'trace-opossum-1' },
    });

    const state = await opossum.getState();
    expect(state.intensityA).toBe(10); // DEFAULT_MAX_OPOSSUM_COLD_START_INTENSITY
  });

  it('applies the opossum step-adjust cap', async () => {
    const opossum = new TestOpossumClient({ intensityA: 10 });
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      opossum,
      llm: new OpossumVibrateAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-step-cap',
      text: '调高负鼠振动',
      context: { sessionId: 'opossum-step-cap', sourceType: 'cli', traceId: 'trace-opossum-2' },
    });

    const state = await opossum.getState();
    // current 10 + clamped delta (10, the default step cap) = 20, not 35.
    expect(state.intensityA).toBe(20);
  });

  it('denies vibrate_start with a device-specific message when opossum is not connected, without touching coyote', async () => {
    const llm = new OpossumVibrateStartLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: true }),
      // No opossum client registered at all.
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'opossum-disconnected',
      text: '启动负鼠',
      context: {
        sessionId: 'opossum-disconnected',
        sourceType: 'cli',
        traceId: 'trace-opossum-disconnected',
      },
    });

    const session = await runtime.getSessionSnapshot('opossum-disconnected');
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接负鼠。',
    );
  });

  it('dispatches set_indicator_color to the paw-prints client', async () => {
    const pawPrints = new TestPawPrintsClient();
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      pawPrints,
      llm: new SetIndicatorColorLlm('paw-prints'),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'indicator-paw-prints',
      text: '把爪印灯光换成紫色',
      context: {
        sessionId: 'indicator-paw-prints',
        sourceType: 'cli',
        traceId: 'trace-indicator-1',
      },
    });

    expect(pawPrints.ledCalls).toEqual([3]);
  });

  it('denies set_indicator_color when the client is connected but has no LED support', async () => {
    const civetEdging = new TestCivetEdgingClient(); // no setIndicatorColor override
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: true }),
      civetEdging,
      llm: new SetIndicatorColorLlm('civet-edging'),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: { maxToolIterations: 1 },
    });

    await runtime.sendUserMessage({
      sessionId: 'indicator-civet-no-led',
      text: '把灵猫灯光换成紫色',
      context: {
        sessionId: 'indicator-civet-no-led',
        sourceType: 'cli',
        traceId: 'trace-indicator-3',
      },
    });

    const session = await runtime.getSessionSnapshot('indicator-civet-no-led');
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接灵猫。',
    );
  });

  it('denies set_indicator_color when the targeted device kind is not connected, naming that device', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: true }),
      // civet-edging not registered.
      llm: new SetIndicatorColorLlm('civet-edging'),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.sendUserMessage({
      sessionId: 'indicator-civet-missing',
      text: '把灵猫灯光换成紫色',
      context: {
        sessionId: 'indicator-civet-missing',
        sourceType: 'cli',
        traceId: 'trace-indicator-2',
      },
    });

    const session = await runtime.getSessionSnapshot('indicator-civet-missing');
    expect(session.messages.at(-1)?.content).toBe(
      '设备未连接，请先点击输入框旁的蓝牙图标连接灵猫。',
    );
  });

  it('buffers paw-prints trigger and civet-edging pressure readings into rolling summaries, independent of the sensor-trigger opt-in toggle', async () => {
    class PlainReplyLlm implements LlmClient {
      async runTurn() {
        return { assistantMessage: '好的' };
      }
    }

    const pawPrints = new TestPawPrintsClient();
    const civetEdging = new TestCivetEdgingClient();
    let capturedPawPrintsSummary: string | undefined;
    let capturedCivetSummary: string | undefined;

    const runtime = new AgentRuntime({
      device: new TestDevice({ connected: false }),
      pawPrints,
      civetEdging,
      llm: new PlainReplyLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      buildInstructions: (input) => {
        capturedPawPrintsSummary = input.pawPrintsSummary;
        capturedCivetSummary = input.civetSummary;
        return '';
      },
    });

    // Deliberately never called setSensorTriggersEnabled — the buffer must
    // still accumulate, unlike SensorTriggerEngine's own opt-in prompts.
    pawPrints.pushReading({ type: 'trigger', eventId: 1, parameterValue: 5 });
    // physical readings are posture/acceleration noise, not trigger events —
    // must not count toward the buffered trigger total.
    pawPrints.pushReading({
      type: 'physical',
      sequence: 1,
      pressState: 0,
      acceleration: 0,
      angleX: 0,
      angleY: 0,
      angleZ: 0,
      extVoltage: 0,
    });
    civetEdging.pushReading({ type: 'pressure', kPa: 12 });

    await runtime.sendUserMessage({
      sessionId: 'buffer-session',
      text: '你好',
      context: { sessionId: 'buffer-session', sourceType: 'cli', traceId: 'trace-buffer-1' },
    });

    expect(capturedPawPrintsSummary).toBe('60s 内触发 1 次，最近事件1');
    expect(capturedCivetSummary).toContain('当前 12.0kPa');
  });

  it('enforces configurable per-turn vibrate_adjust quotas', async () => {
    const opossum = new TestOpossumClient({ intensityA: 10 });
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      opossum,
      llm: new RepeatedVibrateAdjustLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      toolCallConfig: {
        maxToolIterations: 1,
        maxVibrateAdjustCallsPerTurn: 1,
      },
    });
    const events: RuntimeEvent[] = [];
    runtime.subscribe((event) => events.push(event));

    await runtime.sendUserMessage({
      sessionId: 'test',
      text: '负鼠继续加一点',
      context: {
        sessionId: 'test',
        sourceType: 'cli',
        traceId: 'trace-vibrate-quota',
      },
    });

    const denied = events.filter((event) => event.type === 'tool-call-denied');
    expect(denied).toHaveLength(1);
    expect(denied[0] && 'reason' in denied[0] ? denied[0].reason : '').toContain('vibrate_adjust');
  });

  it('emergency stop also silences a connected opossum device', async () => {
    const opossum = new TestOpossumClient({ intensityA: 40, intensityB: 20 });
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      opossum,
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.emergencyStop('any-session');

    const state = await opossum.getState();
    expect(state.intensityA).toBe(0);
    expect(state.intensityB).toBe(0);
  });
});

describe('AgentRuntime sensor trigger opt-in gating', () => {
  it('defaults sensor triggers to disabled for a fresh session', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      pawPrints: new TestPawPrintsClient(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    expect(await runtime.isSensorTriggersEnabledForSession('fresh-session')).toBe(false);
  });

  it('persists the opt-in flag on session metadata once enabled', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      pawPrints: new TestPawPrintsClient(),
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.setSensorTriggersEnabled('opt-in-session', true);
    expect(await runtime.isSensorTriggersEnabledForSession('opt-in-session')).toBe(true);

    await runtime.setSensorTriggersEnabled('opt-in-session', false);
    expect(await runtime.isSensorTriggersEnabledForSession('opt-in-session')).toBe(false);
  });

  it('does not instantiate a trigger engine when no sensor client is registered, even if enabled', async () => {
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      // No pawPrints / civetEdging registered at all.
      llm: new TestLlm(),
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    // Should not throw, and the flag still persists even though nothing
    // is subscribed yet.
    await expect(
      runtime.setSensorTriggersEnabled('no-sensor-session', true),
    ).resolves.toBeUndefined();
    expect(await runtime.isSensorTriggersEnabledForSession('no-sensor-session')).toBe(true);
  });
});

class SensorToolLlm implements LlmClient {
  readonly toolCountsBySource: Array<{ sourceType: string; toolCount: number }> = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
    this.toolCountsBySource.push({
      sourceType: input.context.sourceType,
      toolCount: input.tools.length,
    });

    if (input.context.sourceType === 'sensor') {
      const hasToolOutput = input.conversation?.some(
        (item) => item.kind === 'function_call_output',
      );
      if (!hasToolOutput) {
        return {
          assistantMessage: '感觉到了，稍微加强一点。',
          toolCalls: [
            {
              id: 'tool-sensor-vibrate',
              name: 'vibrate_start',
              args: { channel: 'A', intensity: 5 },
            },
          ],
        };
      }
      return { assistantMessage: '已经响应了传感器事件。' };
    }

    return { assistantMessage: '好的。' };
  }
}

describe('AgentRuntime sensor trigger turns', () => {
  it('a sensor-fired turn keeps tools available and can execute one', async () => {
    const opossum = new TestOpossumClient();
    const pawPrints = new TestPawPrintsClient();
    const llm = new SensorToolLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      opossum,
      pawPrints,
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.setSensorTriggersEnabled('sensor-tools-session', true);

    const responded = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type !== 'assistant-message-completed') return;
        if (event.message.content !== '已经响应了传感器事件。') return;
        unsubscribe();
        resolve();
      });
    });

    pawPrints.pushReading({ type: 'trigger', eventId: 1, parameterValue: 5 });

    await responded;

    expect(
      llm.toolCountsBySource.some((entry) => entry.sourceType === 'sensor' && entry.toolCount > 0),
    ).toBe(true);
    const opossumState = await opossum.getState();
    expect(opossumState.intensityA).toBe(5);
  });

  it('disabling sensor triggers before an event fires means no turn happens at all', async () => {
    const pawPrints = new TestPawPrintsClient();
    const llm = new SensorToolLlm();
    const runtime = new AgentRuntime({
      device: new TestDevice(),
      pawPrints,
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
    });

    await runtime.setSensorTriggersEnabled('sensor-disabled-session', true);
    await runtime.setSensorTriggersEnabled('sensor-disabled-session', false);

    pawPrints.pushReading({ type: 'trigger', eventId: 1, parameterValue: 5 });
    // Give any stray microtask/queued work a chance to run before asserting nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(llm.toolCountsBySource).toHaveLength(0);
    const session = await runtime.getSessionSnapshot('sensor-disabled-session');
    expect(session.messages).toHaveLength(0);
  });
});
