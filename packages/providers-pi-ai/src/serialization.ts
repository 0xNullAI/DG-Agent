import type {
  LlmConversationItem,
  LlmTurnInput,
  SessionSnapshot,
  ToolCall as DgToolCall,
  ToolDefinition,
} from '@dg-agent/core';
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall as PiToolCall,
  TSchema,
  Usage,
} from '@earendil-works/pi-ai';

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Same fallback `toConversationItems` provides in providers-openai-http:
 * `agent-runtime.ts` always passes `input.conversation` explicitly, so this
 * only matters for callers (tests, ad-hoc scripts) that invoke `runTurn`
 * directly against a bare session.
 */
function toConversationItems(session: SessionSnapshot): LlmConversationItem[] {
  return session.messages.map((item) => ({
    kind: 'message',
    role: item.role,
    content: item.content,
    reasoningContent: item.reasoningContent,
    toolCalls: item.toolCalls,
  }));
}

function toPiTool(tool: ToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    // `ToolDefinition.parameters` is a plain JSON Schema object (see
    // @dg-kit/core). pi-ai's dialect converters only ever read `.properties`
    // / `.required` off `Tool.parameters` at request-build time — they don't
    // run it through typebox's compiler — so a structurally-JSON-Schema
    // object is safe here even though it wasn't built via `Type.Object(...)`.
    parameters: tool.parameters as unknown as TSchema,
  };
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface BuildContextOptions {
  api: Api;
  provider: string;
  model: string;
}

/**
 * Converts this codebase's `LlmConversationItem[]` (shared with
 * providers-openai-http) into pi-ai's `Context`. `kind: 'function_call'` and
 * `kind: 'function_call_output'` are two halves of a tool round-trip that
 * arrive as separate conversation items; pi-ai instead wants a single
 * `AssistantMessage` with a `toolCall` content block plus a matching
 * `ToolResultMessage`. Google's `functionResponse` additionally requires the
 * tool *name*, which our `function_call_output` items don't carry — so this
 * tracks callId -> name as it walks the conversation and backfills it.
 */
export function buildContext(input: LlmTurnInput, options: BuildContextOptions): Context {
  const conversation = input.conversation ?? toConversationItems(input.session);
  const messages: Message[] = [];
  const toolNameByCallId = new Map<string, string>();
  let timestamp = 0;

  const assistantEnvelope = {
    api: options.api,
    provider: options.provider,
    model: options.model,
    usage: EMPTY_USAGE,
    stopReason: 'stop' as const,
  };

  for (const item of conversation) {
    if (item.kind === 'message') {
      // Persisted system-role messages are filtered out of model context
      // upstream (runtime-turn-state.ts `shouldSkipModelContextMessage`), so
      // this is defensive rather than a real path.
      if (item.role === 'system') continue;

      if (item.role === 'user') {
        messages.push({ role: 'user', content: item.content, timestamp: timestamp++ });
        continue;
      }

      const content: AssistantMessage['content'] = [];
      if (item.content) {
        content.push({ type: 'text', text: item.content });
      }
      for (const call of item.toolCalls ?? []) {
        toolNameByCallId.set(call.id, call.name);
        content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.args });
      }
      if (content.length === 0) continue;

      messages.push({ role: 'assistant', content, timestamp: timestamp++, ...assistantEnvelope });
      continue;
    }

    if (item.kind === 'function_call') {
      toolNameByCallId.set(item.callId, item.name);
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: item.callId,
            name: item.name,
            arguments: parseArguments(item.argumentsJson),
          },
        ],
        timestamp: timestamp++,
        ...assistantEnvelope,
      });
      continue;
    }

    // kind === 'function_call_output'
    messages.push({
      role: 'toolResult',
      toolCallId: item.callId,
      toolName: toolNameByCallId.get(item.callId) ?? item.callId,
      content: [{ type: 'text', text: item.output }],
      isError: false,
      timestamp: timestamp++,
    });
  }

  return {
    systemPrompt: input.instructions.trim() || undefined,
    messages,
    tools: input.tools.length > 0 ? input.tools.map(toPiTool) : undefined,
  };
}

export function extractText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

export function extractReasoning(message: AssistantMessage): string | undefined {
  const thinking = message.content
    .filter((block): block is ThinkingContent => block.type === 'thinking')
    .map((block) => block.thinking)
    .filter((text) => text.trim().length > 0)
    .join('\n\n');
  return thinking || undefined;
}

export function extractToolCalls(message: AssistantMessage): DgToolCall[] {
  return message.content
    .filter((block): block is PiToolCall => block.type === 'toolCall')
    .map((block) => ({ id: block.id, name: block.name, args: block.arguments ?? {} }));
}
