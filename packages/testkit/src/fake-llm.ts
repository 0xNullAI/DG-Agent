import type { LlmPort, LlmTurnInput, LlmTurnResult } from '@dg-agent/contracts';
import type { ToolCall } from '@dg-agent/core';

function nextToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    args,
  };
}

export class FakeLlmPort implements LlmPort {
  async runTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    const latestToolOutput = [...(input.conversation ?? [])]
      .reverse()
      .find((item) => item.kind === 'function_call_output');
    if (latestToolOutput?.kind === 'function_call_output') {
      return {
        assistantMessage: `Fake LLM 已完成工具执行：${latestToolOutput.output}`,
      };
    }

    const text = input.message.trim();

    if (/启动\s*A|启动A|start\s*a/i.test(text)) {
      const strength = Number(text.match(/(\d+)/)?.[1] ?? 8);
      return {
        assistantMessage: `收到，准备启动 A 通道，目标强度 ${strength}。`,
        toolCalls: [
          nextToolCall('start', {
            channel: 'A',
            strength,
            waveformId: 'pulse_mid',
            loop: true,
          }),
        ],
      };
    }

    if (/启动\s*B|启动B|start\s*b/i.test(text)) {
      const strength = Number(text.match(/(\d+)/)?.[1] ?? 8);
      return {
        assistantMessage: `收到，准备启动 B 通道，目标强度 ${strength}。`,
        toolCalls: [
          nextToolCall('start', {
            channel: 'B',
            strength,
            waveformId: 'pulse_mid',
            loop: true,
          }),
        ],
      };
    }

    if (/停止|stop/i.test(text)) {
      return {
        assistantMessage: '收到，正在停止输出。',
        toolCalls: [nextToolCall('stop', {})],
      };
    }

    if (/紧急停止|emergency/i.test(text)) {
      return {
        assistantMessage: '收到，执行紧急停止。',
        toolCalls: [nextToolCall('emergency_stop', {})],
      };
    }

    if (/增强|调高|increase|\+\d+/i.test(text)) {
      const delta = Number(text.match(/([+-]?\d+)/)?.[1] ?? 5);
      return {
        assistantMessage: `收到，尝试调整 A 通道强度 ${delta > 0 ? '+' : ''}${delta}。`,
        toolCalls: [
          nextToolCall('adjust_strength', {
            channel: 'A',
            delta,
          }),
        ],
      };
    }

    return {
      assistantMessage: `Fake LLM 已收到：${text}`,
    };
  }
}
