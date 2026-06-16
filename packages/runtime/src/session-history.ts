import type { LlmConversationItem } from '@dg-agent/core';
import {
  createMessage,
  type ConversationMessage,
  type RuntimeTraceEntry,
  type SessionSnapshot,
  type ToolCall,
  type ToolCallResult,
} from '@dg-agent/core';

export function normalizeSessionHistory(session: SessionSnapshot): boolean {
  let changed = false;
  const normalizedMessages: ConversationMessage[] = [];

  for (const message of session.messages) {
    if (message.role === 'system' || isInternalSyntheticMessage(message.content)) {
      changed = true;
      continue;
    }

    if (message.role === 'assistant') {
      const previousComparable = findPreviousComparableMessage(normalizedMessages);
      if (
        previousComparable?.role === 'assistant' &&
        areAssistantMessagesEquivalent(previousComparable, message)
      ) {
        if (hasCompleteToolRound(message) && !hasCompleteToolRound(previousComparable)) {
          const index = normalizedMessages.lastIndexOf(previousComparable);
          if (index >= 0) {
            normalizedMessages[index] = message;
          }
        }
        changed = true;
        continue;
      }
    }

    normalizedMessages.push(message);
  }

  if (!changed) {
    return false;
  }

  session.messages = normalizedMessages;
  session.updatedAt = Date.now();
  return true;
}

function findPreviousComparableMessage(
  messages: ConversationMessage[],
): ConversationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index];
    if (!current) continue;
    return current;
  }

  return undefined;
}

export function hasCompleteToolRound(message: ConversationMessage): boolean {
  const toolCalls = message.toolCalls ?? [];
  const toolResults = message.toolResults ?? [];
  if (toolCalls.length === 0 || toolResults.length !== toolCalls.length) {
    return false;
  }

  return toolCalls.every((toolCall) => toolResults.some((result) => result.callId === toolCall.id));
}

export function hydrateToolResultsFromTrace(
  session: SessionSnapshot,
  trace: RuntimeTraceEntry[],
): boolean {
  let changed = false;

  for (const message of session.messages) {
    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      continue;
    }
    if (hasCompleteToolRound(message)) {
      continue;
    }

    const toolResults = message.toolCalls.flatMap((toolCall) => {
      const output = resolveTraceToolOutput(trace, toolCall.id);
      return output ? [{ callId: toolCall.id, output }] : [];
    });

    if (toolResults.length !== message.toolCalls.length) {
      continue;
    }

    message.toolResults = toolResults;
    changed = true;
  }

  return changed;
}

export function appendAssistantToolRound(
  session: SessionSnapshot,
  input: {
    content: string;
    reasoningContent?: string;
    toolCalls: ToolCall[];
    toolResults: ToolCallResult[];
  },
  turnStartIndex: number,
): ConversationMessage {
  const message = appendAssistantMessage(
    session,
    {
      content: input.content,
      reasoningContent: input.reasoningContent,
      toolCalls: input.toolCalls.length > 0 ? input.toolCalls : undefined,
    },
    turnStartIndex,
  );
  if (input.toolCalls.length > 0) {
    message.toolCalls = structuredClone(input.toolCalls);
  }
  message.toolResults =
    input.toolResults.length > 0 ? structuredClone(input.toolResults) : undefined;
  return message;
}

export function appendAssistantMessage(
  session: SessionSnapshot,
  input: {
    content: string;
    reasoningContent?: string;
    toolCalls?: ToolCall[];
  },
  turnStartIndex: number,
): ConversationMessage {
  const normalized = buildAssistantMessageSignature(input);
  const existing = session.messages.slice(turnStartIndex + 1).find(
    (message) =>
      message.role === 'assistant' &&
      buildAssistantMessageSignature({
        content: message.content,
        reasoningContent: message.reasoningContent,
        toolCalls: message.toolCalls,
      }) === normalized,
  );
  if (existing) {
    return existing;
  }

  const message = createMessage('assistant', input.content, Date.now(), {
    reasoningContent: input.reasoningContent,
    toolCalls: input.toolCalls,
  });
  session.messages.push(message);
  return message;
}

function areAssistantMessagesEquivalent(
  left: ConversationMessage,
  right: ConversationMessage,
): boolean {
  return (
    buildAssistantMessageSignature({
      content: left.content,
      reasoningContent: left.reasoningContent,
      toolCalls: left.toolCalls,
    }) ===
    buildAssistantMessageSignature({
      content: right.content,
      reasoningContent: right.reasoningContent,
      toolCalls: right.toolCalls,
    })
  );
}

export function buildAssistantMessageSignature(input: {
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
}): string {
  // Dedup by visible text and reasoning only. Tool calls are intentionally
  // excluded so an iteration that emitted "X" with a tool call dedupes against
  // a later final reply that emits "X" without tool calls — unless the message
  // is tool-only (empty visible text), in which case tool calls identify it.
  const toolSignature =
    input.content.trim().length === 0 && input.toolCalls?.length
      ? input.toolCalls
          .map((toolCall) => `${toolCall.id}:${toolCall.name}:${safeStringify(toolCall.args)}`)
          .join('|')
      : '';
  return JSON.stringify({
    content: input.content.trim(),
    reasoningContent: input.reasoningContent?.trim() ?? '',
    toolSignature,
  });
}

function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

export function appendSkippedToolOutputs(
  target: LlmConversationItem[],
  toolCalls: ToolCall[],
  reason: string,
): void {
  for (const toolCall of toolCalls) {
    target.push({
      kind: 'function_call_output',
      callId: toolCall.id,
      output: JSON.stringify({
        error: reason,
        _meta: {
          kind: 'tool-denied',
          toolName: toolCall.name,
        },
      }),
    });
  }
}

function isInternalSyntheticMessage(content: string): boolean {
  return (
    content.startsWith('[Timer due]') ||
    content.startsWith('[内部提醒]') ||
    content.startsWith('[系统事件：定时器到期]')
  );
}

function resolveTraceToolOutput(trace: RuntimeTraceEntry[], callId: string): string | null {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const entry = trace[index];
    if (!entry || entry.toolCallId !== callId) {
      continue;
    }

    if (entry.kind === 'tool-result' && entry.output) {
      return entry.output;
    }

    if (entry.kind === 'tool-denied') {
      return JSON.stringify({
        error: entry.detail ?? 'denied',
        _meta: {
          kind: 'tool-denied',
          toolName: entry.toolName,
        },
      });
    }

    if (entry.kind === 'tool-failed') {
      return JSON.stringify({
        error: entry.detail ?? 'failed',
        _meta: {
          kind: 'tool-failed',
          toolName: entry.toolName,
        },
      });
    }
  }

  return null;
}
