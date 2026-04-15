/**
 * policies.ts — Hard constraints and runtime guards for the agent loop.
 *
 * This module is the single source of truth for every code-level rule that
 * the LLM cannot bypass. It is intentionally pure: zero side effects, zero
 * imports from other agent modules. The runner consults policies at the
 * per-call cap and per-tool cap checkpoints.
 */

// ---------------------------------------------------------------------------
// Per-turn caps
// ---------------------------------------------------------------------------

/** Hard ceiling on tool-loop iterations within a single user turn. */
export const MAX_TOOL_ITERATIONS = 5;

/** Hard ceiling on total tool calls (any tool) within a single user turn. */
export const MAX_TOOL_CALLS_PER_TURN = 5;

/** Hard ceiling on adjust_strength calls within a single user turn. */
export const MAX_ADJUST_STRENGTH_PER_TURN = 2;

/** Hard ceiling on burst calls per channel within a single user turn. */
export const MAX_BURST_PER_CHANNEL_PER_TURN = 1;

/** Hard ceiling on the duration of a single burst, in milliseconds. */
export const MAX_BURST_DURATION_MS = 5000;

/**
 * Hard ceiling on the strength `start` may write. Cold-starting a stopped
 * channel must always be a soft start — the model can never blast the user
 * from zero to high intensity in one call. Further escalation must go
 * through adjust_strength, one step at a time.
 */
export const MAX_START_STRENGTH = 10;

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** Tools that mutate device output (i.e. actually do something physical). */
const MUTATING_TOOLS = new Set<string>([
  'start',
  'stop',
  'adjust_strength',
  'change_wave',
  'burst',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}
