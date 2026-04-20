export interface ToolCallConfig {
  maxToolIterations: number;
  maxToolCallsPerTurn: number;
  maxAdjustStrengthCallsPerTurn: number;
  maxBurstCallsPerTurn: number;
  burstRequiresActiveChannel: boolean;
}

export interface ToolCallConfigInput {
  maxToolIterations?: number;
  maxToolCallsPerTurn?: number;
  maxAdjustStrengthCallsPerTurn?: number;
  maxBurstCallsPerTurn?: number;
  burstRequiresActiveChannel?: boolean;
}

export function createDefaultToolCallConfig(): ToolCallConfig {
  return {
    maxToolIterations: 5,
    maxToolCallsPerTurn: 5,
    maxAdjustStrengthCallsPerTurn: 2,
    maxBurstCallsPerTurn: 1,
    burstRequiresActiveChannel: true,
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
    maxBurstCallsPerTurn: normalizeCount(input.maxBurstCallsPerTurn, defaults.maxBurstCallsPerTurn),
    burstRequiresActiveChannel:
      input.burstRequiresActiveChannel ?? defaults.burstRequiresActiveChannel,
  };
}

function normalizeCount(value: number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.round(parsed));
}
