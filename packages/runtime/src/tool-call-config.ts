export interface ToolCallConfig {
  maxToolIterations: number;
  maxToolCallsPerTurn: number;
  maxAdjustStrengthCallsPerTurn: number;
  maxBurstCallsPerTurn: number;
  burstRequiresActiveChannel: boolean;
  /** Opossum's adjust_strength-equivalent per-turn cap. Mirrors maxAdjustStrengthCallsPerTurn. */
  maxVibrateAdjustCallsPerTurn: number;
}

export interface ToolCallConfigInput {
  maxToolIterations?: number;
  maxToolCallsPerTurn?: number;
  maxAdjustStrengthCallsPerTurn?: number;
  maxBurstCallsPerTurn?: number;
  burstRequiresActiveChannel?: boolean;
  maxVibrateAdjustCallsPerTurn?: number;
}

export function createDefaultToolCallConfig(): ToolCallConfig {
  return {
    maxToolIterations: 5,
    maxToolCallsPerTurn: 5,
    maxAdjustStrengthCallsPerTurn: 2,
    maxBurstCallsPerTurn: 1,
    burstRequiresActiveChannel: true,
    maxVibrateAdjustCallsPerTurn: 2,
  };
}

export function resolveToolCallConfig(input: ToolCallConfigInput = {}): ToolCallConfig {
  const defaults = createDefaultToolCallConfig();
  return {
    maxToolIterations: normalizeCount(input.maxToolIterations, defaults.maxToolIterations),
    maxToolCallsPerTurn: normalizeCount(input.maxToolCallsPerTurn, defaults.maxToolCallsPerTurn),
    maxAdjustStrengthCallsPerTurn: normalizeCount(
      input.maxAdjustStrengthCallsPerTurn,
      defaults.maxAdjustStrengthCallsPerTurn,
    ),
    // Burst alone may go to 0 — that's the "disable bursts entirely" config
    // some users prefer (issue #67). The other caps must stay ≥ 1, otherwise
    // the agent loop would stall immediately on the first iteration.
    maxBurstCallsPerTurn: normalizeBurstCount(
      input.maxBurstCallsPerTurn,
      defaults.maxBurstCallsPerTurn,
    ),
    burstRequiresActiveChannel:
      input.burstRequiresActiveChannel ?? defaults.burstRequiresActiveChannel,
    maxVibrateAdjustCallsPerTurn: normalizeCount(
      input.maxVibrateAdjustCallsPerTurn,
      defaults.maxVibrateAdjustCallsPerTurn,
    ),
  };
}

function normalizeCount(value: number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.round(parsed));
}

function normalizeBurstCount(value: number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed));
}
