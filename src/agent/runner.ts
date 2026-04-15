/**
 * runner.ts — Agent tool-call loop.
 *
 * One `runTurn` invocation handles a single user turn:
 *   - Iterates LLM calls until the model produces a final assistant text
 *   - Executes tool calls between iterations (after the permission gate)
 *   - Enforces all per-turn hard caps from `policies.ts`
 *   - Streams text + tool events through the AgentSink
 *
 * The runner owns one piece of state (`RunnerState`) that lives only for the
 * duration of one `runTurn` call. Nothing leaks out except assistant text —
 * tool calls and tool outputs stay inside the runner. When the "narrate then
 * act" pattern is used (the model streams text before calling a tool) those
 * narration lines ARE returned so the persisted chat history matches what
 * the user actually saw on screen.
 */

import type { AgentSink, ConversationItem, DeviceState, ToolDef } from '../types';
import {
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_ADJUST_STRENGTH_PER_TURN,
  MAX_BURST_PER_CHANNEL_PER_TURN,
} from './policies';
import type { TurnToolCall } from './prompts';
import { callResponses, type TransportConfig } from './transport';

// ---------------------------------------------------------------------------
// Runner input contract
// ---------------------------------------------------------------------------

export interface RunTurnInput {
  /** The pristine conversation history (user/assistant text only). */
  conversationItems: readonly ConversationItem[];
  /**
   * Builds the system instructions for one iteration. Called every iter.
   * The third arg is the list of tool calls already executed earlier in
   * this same turn — empty on the first iteration, populated thereafter.
   * The prompt builder uses this to inject a "what you've done so far"
   * block so the model cannot hallucinate device actions it never took.
   */
  buildInstructions: (
    deviceStatus: DeviceState,
    isFirstIteration: boolean,
    turnToolCalls: readonly TurnToolCall[],
  ) => string;
  /** Reads the latest device status. Called every iter so the LLM sees fresh state. */
  getDeviceStatus: () => DeviceState;
  /** Tool schemas for the LLM. */
  tools: ToolDef[];
  /** Executes a tool by name. Errors must be returned as JSON, not thrown. */
  executor: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Provider/transport configuration. */
  transportConfig: TransportConfig;
  /** UI sink for streaming + tool notifications. */
  sink: AgentSink;
  /** Optional cancel signal — honoured at loop start and inside fetch. */
  signal?: AbortSignal;
  /**
   * Optional permission gate for mutating tool calls. When provided, the
   * runner consults this function for each tool execution (after caps,
   * before the executor) and expects a simple allow/deny decision. The
   * caller owns the grant cache and UI interaction.
   */
  requestPermission?: (
    toolName: string,
    args: Record<string, unknown>,
  ) => Promise<'allow' | 'deny'>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

// ---------------------------------------------------------------------------
// Internal per-turn state
// ---------------------------------------------------------------------------

interface RunnerState {
  /** Items appended during this turn (tool calls, outputs). */
  workingItems: ConversationItem[];
  /** Total tool calls so far this turn (any tool). */
  totalToolCalls: number;
  /** adjust_strength calls so far this turn. */
  adjustStrengthCalls: number;
  /** burst calls so far this turn, counted per channel. */
  burstCallsByChannel: { A: number; B: number };
}

function newState(): RunnerState {
  return {
    workingItems: [],
    totalToolCalls: 0,
    adjustStrengthCalls: 0,
    burstCallsByChannel: { A: 0, B: 0 },
  };
}

function normalizeChannel(raw: unknown): 'A' | 'B' | null {
  if (typeof raw !== 'string') return null;
  const up = raw.toUpperCase();
  return up === 'A' || up === 'B' ? up : null;
}

/**
 * Project workingItems into the compact form the prompt builder needs:
 * one entry per executed tool call, in chronological order, carrying just
 * the name and the raw args JSON string. Tool outputs and narration items
 * are skipped — the model only needs to know what it *did*, not the result
 * payloads (those are still in the conversation input via the function_call
 * / function_call_output pairs).
 */
function collectTurnToolCalls(state: RunnerState): TurnToolCall[] {
  const out: TurnToolCall[] = [];
  for (const it of state.workingItems) {
    if ((it as any).type === 'function_call') {
      const fc = it as any;
      out.push({ name: fc.name, argsJson: fc.arguments || '{}' });
    }
  }
  return out;
}

/**
 * Pick out every assistant narration line accumulated during the turn.
 * workingItems also contains function_call / function_call_output items —
 * those don't belong in the persisted chat history.
 */
function collectNarrations(state: RunnerState): ConversationItem[] {
  return state.workingItems.filter(
    (it): it is ConversationItem => (it as any).role === 'assistant',
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one user turn. Returns the items that should be persisted into the
 * conversation history: zero or more `{role:'assistant'}` narration items
 * followed by one final `{role:'assistant'}` reply (or the iteration-ceiling
 * sentinel). Tool items and correction notes stay inside the runner and
 * never leak.
 */
export async function runTurn(input: RunTurnInput): Promise<ConversationItem[]> {
  const state = newState();

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    throwIfAborted(input.signal);

    const deviceStatus = input.getDeviceStatus();
    const turnToolCalls = collectTurnToolCalls(state);
    const instructions = input.buildInstructions(deviceStatus, iter === 0, turnToolCalls);
    const llmInput: ConversationItem[] = [...input.conversationItems, ...state.workingItems];

    const { outputItems, streamedText } = await callResponses(
      llmInput,
      instructions,
      input.tools,
      input.transportConfig,
      input.sink.onTextDelta.bind(input.sink),
      input.signal,
    );

    const fnCalls = outputItems.filter((o: any) => o.type === 'function_call');

    if (fnCalls.length > 0) {
      await handleToolCalls(fnCalls, streamedText, state, input);
      continue;
    }

    // No tool calls — accept the reply. Lock the bubble and return every
    // assistant message produced this turn — the "narrate then act" lines
    // plus the final text.
    input.sink.onTextComplete();
    return [...collectNarrations(state), { role: 'assistant', content: streamedText }];
  }

  // Iteration ceiling reached. The model spent all iterations on tool calls
  // without producing a final reply. Show a friendly sentinel so the user
  // sees that the agent gave up rather than a silent stop, and keep any
  // narration the model did emit along the way.
  const sentinel = '嗯…我这边有点绕进去了，可以换个说法再问一次吗？';
  input.sink.onTextDiscard();
  input.sink.onTextInline(sentinel);
  return [...collectNarrations(state), { role: 'assistant', content: sentinel }];
}

// ---------------------------------------------------------------------------
// Tool execution sub-step
// ---------------------------------------------------------------------------

async function handleToolCalls(
  fnCalls: any[],
  streamedText: string,
  state: RunnerState,
  input: RunTurnInput,
): Promise<void> {
  // Any text the model emitted before the tool calls (the "narrate then act"
  // pattern). Lock that bubble in so the next iter starts a fresh one.
  if (streamedText) {
    input.sink.onTextComplete();
    state.workingItems.push({ role: 'assistant', content: streamedText });
  }

  // Push all function_call items first so the LLM input contains call/output
  // pairs in the right order on the next iteration.
  for (const fc of fnCalls) {
    state.workingItems.push({
      type: 'function_call',
      call_id: fc.call_id,
      name: fc.name,
      arguments: fc.arguments,
    });
  }

  for (const fc of fnCalls) {
    const args = parseArgs(fc.arguments);
    const result = await executeOneCall(fc.name, args, state, input);

    state.workingItems.push({
      type: 'function_call_output',
      call_id: fc.call_id,
      output: result,
    });

    input.sink.onToolCall(fc.name, args, result);
  }
}

async function executeOneCall(
  name: string,
  args: Record<string, unknown>,
  state: RunnerState,
  input: RunTurnInput,
): Promise<string> {
  // Hard cap: total tool calls per turn
  if (state.totalToolCalls >= MAX_TOOL_CALLS_PER_TURN) {
    return JSON.stringify({
      error: `本回合工具调用总数已达上限 (${MAX_TOOL_CALLS_PER_TURN})，本次调用被拒绝。请直接回复用户，不要再发起工具调用。`,
    });
  }

  // Hard cap: adjust_strength per turn
  if (name === 'adjust_strength' && state.adjustStrengthCalls >= MAX_ADJUST_STRENGTH_PER_TURN) {
    return JSON.stringify({
      error: `adjust_strength 本回合调用已达上限 (${MAX_ADJUST_STRENGTH_PER_TURN} 次)，本次调用被拒绝。本回合已经调整过足够多次了，请直接回复用户，不要再继续爬升强度。`,
    });
  }

  // Hard cap: burst per channel per turn
  const burstChannel = name === 'burst' ? normalizeChannel(args.channel) : null;
  if (
    name === 'burst' &&
    burstChannel &&
    state.burstCallsByChannel[burstChannel] >= MAX_BURST_PER_CHANNEL_PER_TURN
  ) {
    return JSON.stringify({
      error: `burst 通道 ${burstChannel} 本回合调用已达上限 (${MAX_BURST_PER_CHANNEL_PER_TURN} 次)，本次调用被拒绝。同一通道的短时突增每回合只允许一次，请直接回复用户，不要重复触发。`,
    });
  }

  // Permission gate. May block on a modal dialog.
  let permissionDenied = false;
  if (input.requestPermission) {
    const decision = await input.requestPermission(name, args);
    if (decision === 'deny') permissionDenied = true;
  }

  // Always count attempted calls against the per-turn caps — a denied or
  // failed call still burns a slot, so the model can't spam-retry to bypass
  // MAX_TOOL_CALLS_PER_TURN.
  state.totalToolCalls++;
  if (name === 'adjust_strength') state.adjustStrengthCalls++;
  if (name === 'burst' && burstChannel) state.burstCallsByChannel[burstChannel]++;

  if (permissionDenied) {
    return JSON.stringify({
      error:
        '用户拒绝了本次工具调用。请不要立即用相同参数重试，也不要在回复里声称已经执行。改为询问用户是否愿意改用别的方式，或直接给出文字建议。',
    });
  }

  try {
    const result = await input.executor(name, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  const s = raw || '{}';
  try {
    return JSON.parse(s);
  } catch {
    // fall through to the light repair pass
  }
  try {
    return JSON.parse(repairJson(s));
  } catch {
    return {};
  }
}

/**
 * Minimal JSON repair for lightly-malformed tool-call arguments.
 *
 * Volcengine's Function Calling docs explicitly call out that the model may
 * emit slightly-invalid JSON under pressure and recommend a repair pass
 * before giving up. We deliberately keep this tiny (no external dependency,
 * no regex explosion) and only cover the three failure modes we've actually
 * seen: trailing commas, unclosed brackets/braces, and raw newlines inside
 * string literals. If a payload is corrupt in more exotic ways the caller
 * still falls back to {} and the tool returns an error upstream.
 */
function repairJson(raw: string): string {
  // Walk the string once, tracking context (in-string, escape, bracket stack),
  // and emit a cleaned copy. We cannot do any of this with a blanket regex
  // because commas and brackets inside string literals are legal.
  const stack: string[] = [];
  let out = '';
  let inStr = false;
  let escape = false;

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];

    if (inStr) {
      if (escape) {
        out += c;
        escape = false;
        continue;
      }
      if (c === '\\') {
        out += c;
        escape = true;
        continue;
      }
      if (c === '"') {
        out += c;
        inStr = false;
        continue;
      }
      // Raw control chars inside strings are illegal in JSON; escape them.
      if (c === '\n') {
        out += '\\n';
        continue;
      }
      if (c === '\r') {
        out += '\\r';
        continue;
      }
      if (c === '\t') {
        out += '\\t';
        continue;
      }
      out += c;
      continue;
    }

    if (c === '"') {
      out += c;
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') {
      stack.push(c);
      out += c;
      continue;
    }
    if (c === '}' || c === ']') {
      // Drop trailing commas that immediately precede a closer: find the
      // last non-whitespace char in the output and strip it if it's ','.
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      if (j >= 0 && out[j] === ',') out = out.slice(0, j) + out.slice(j + 1);
      stack.pop();
      out += c;
      continue;
    }
    out += c;
  }

  // Close any still-open string, then any still-open containers in
  // reverse order. An unterminated string gets a closing quote, which
  // is usually enough to rescue a truncated final argument value.
  if (inStr) out += '"';
  while (stack.length) {
    const open = stack.pop();
    out += open === '{' ? '}' : ']';
  }
  return out;
}
