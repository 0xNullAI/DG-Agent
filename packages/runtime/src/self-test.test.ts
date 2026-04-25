/// <reference types="node" />

import assert from 'node:assert/strict';
import { it } from 'vitest';
import type { DeviceClient, LlmClient, PermissionService, SessionStore } from '@dg-agent/core';
import { createDefaultPolicyRules } from './default-policies.js';
import {
  createEmptyDeviceState,
  getBridgeOriginMetadata,
  createMessage,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type ModelContextStrategy,
  type RuntimeEvent,
} from '@dg-agent/core';
import { AgentRuntime } from './agent-runtime.js';
import { PolicyEngine } from './policy-engine.js';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';

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

class TestLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class InspectingTestLlm implements LlmClient {
  readonly conversations: Array<
    ReadonlyArray<NonNullable<Parameters<LlmClient['runTurn']>[0]['conversation']>[number]>
  > = [];

  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

class TestPermission implements PermissionService {
  async request(_input: Parameters<PermissionService['request']>[0]) {
    return { type: 'approve-once' } as const;
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

class LegacyStartArgsLlm implements LlmClient {
  async runTurn(input: Parameters<LlmClient['runTurn']>[0]) {
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

it('runtime self-test scenarios', async () => {
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
      (item) =>
        item.kind === 'message' && item.role === 'assistant' && item.content === '准备启动 A',
    ) ?? [];
  assert.equal(duplicatedNarrations.length, 1);

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
  const contextCases: Array<{ strategy: ModelContextStrategy; expected: string[] }> = [
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

  for (const testCase of contextCases) {
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

    const runtimeWithStrategy = new AgentRuntime({
      device: new TestDevice(),
      llm,
      permission: new TestPermission(),
      waveformLibrary: createBasicWaveformLibrary(),
      sessionStore,
      modelContextStrategy: testCase.strategy,
    });

    await runtimeWithStrategy.sendUserMessage({
      sessionId: `context-${testCase.strategy}`,
      text: 'u7',
      context: {
        sessionId: `context-${testCase.strategy}`,
        sourceType: 'cli',
        traceId: `trace-${testCase.strategy}`,
      },
    });

    assert.deepEqual(llm.conversations[0], testCase.expected);
  }

  const bridgeOriginRuntime = new AgentRuntime({
    device: new TestDevice(),
    llm: new TestLlm(),
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
  });
  await bridgeOriginRuntime.sendUserMessage({
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
  const bridgeOriginSession = await bridgeOriginRuntime.getSessionSnapshot('bridge-active-session');
  assert.deepEqual(getBridgeOriginMetadata(bridgeOriginSession.metadata), {
    platform: 'qq',
    userId: 'group:123456',
    userName: 'Test Group',
  });

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

  const adjustStepRuntime = new AgentRuntime({
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
  await adjustStepRuntime.sendUserMessage({
    sessionId: 'adjust-step',
    text: '鍔犲ぇ涓€鐐?',
    context: {
      sessionId: 'adjust-step',
      sourceType: 'cli',
      traceId: 'trace-adjust-step',
    },
  });
  const adjustStepSession = await adjustStepRuntime.getSessionSnapshot('adjust-step');
  assert.equal(adjustStepSession.deviceState.strengthA, 25);

  const coldStartRuntime = new AgentRuntime({
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
  await coldStartRuntime.sendUserMessage({
    sessionId: 'cold-start',
    text: '鍚姩 A',
    context: {
      sessionId: 'cold-start',
      sourceType: 'cli',
      traceId: 'trace-cold-start',
    },
  });
  const coldStartSession = await coldStartRuntime.getSessionSnapshot('cold-start');
  assert.equal(coldStartSession.deviceState.strengthA, 12);

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
    burstDeniedEvents.some(
      (event) => event.type === 'device-command-executed' && event.command.type === 'burst',
    ),
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

  const burstDurationEvents: RuntimeEvent[] = [];
  const burstDurationRuntime = new AgentRuntime({
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
  burstDurationRuntime.subscribe((event) => {
    burstDurationEvents.push(event);
  });
  await burstDurationRuntime.sendUserMessage({
    sessionId: 'burst-duration',
    text: 'burst 久一点',
    context: {
      sessionId: 'burst-duration',
      sourceType: 'cli',
      traceId: 'trace-burst-duration',
    },
  });
  const burstDurationEvent = burstDurationEvents.find(
    (
      event,
    ): event is Extract<RuntimeEvent, { type: 'device-command-executed' }> & {
      command: Extract<DeviceCommand, { type: 'burst' }>;
    } => event.type === 'device-command-executed' && event.command.type === 'burst',
  );
  assert.equal(burstDurationEvent?.command.durationMs ?? null, 1200);

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
});
