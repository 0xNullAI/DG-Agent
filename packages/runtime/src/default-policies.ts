import type { DeviceCommand, OpossumCommand } from '@dg-agent/core';
import type { OpossumPolicyRule } from './policy-engine.js';
import type { PolicyRule } from './policy-engine.js';

export const DEFAULT_MAX_COLD_START_STRENGTH = 10;
export const DEFAULT_MAX_ADJUST_STEP = 10;
export const DEFAULT_MAX_BURST_DURATION_MS = 5_000;
const MAX_ADJUST_STEP_LIMIT = 200;
const MAX_BURST_DURATION_LIMIT_MS = 20_000;
const DEFAULT_USER_MAX_STRENGTH = 50;

// Opossum intensity is also a 0-200 range (see OpossumCommand doc comment in
// @dg-kit/core), so its safety caps default to the same magnitude as
// Coyote's cold-start / step-adjust caps rather than inventing new numbers.
export const DEFAULT_MAX_OPOSSUM_COLD_START_INTENSITY = 10;
export const DEFAULT_MAX_OPOSSUM_ADJUST_STEP = 10;

export interface DefaultPolicyOptions {
  maxStrengthA?: number;
  maxStrengthB?: number;
  maxColdStartStrength?: number;
  maxAdjustStep?: number;
  maxBurstDurationMs?: number;
  // Issue #68: extra caps that apply only to `burst` commands, narrower
  // than the per-channel strength cap. 0 (default) = disabled.
  maxBurstStrengthAbsolute?: number;
  maxBurstStrengthRelative?: number;
}

function requiresConfirmation(command: DeviceCommand): boolean {
  return command.type !== 'stop' && command.type !== 'emergencyStop';
}

export function createDefaultPolicyRules(options: DefaultPolicyOptions = {}): PolicyRule[] {
  const maxStrengthA = normalizeStrengthLimit(options.maxStrengthA);
  const maxStrengthB = normalizeStrengthLimit(options.maxStrengthB);
  const maxColdStartStrength = normalizeColdStartStrengthLimit(options.maxColdStartStrength);
  const maxAdjustStep = normalizeAdjustStepLimit(options.maxAdjustStep);
  const maxBurstDurationMs = normalizeBurstDurationLimit(options.maxBurstDurationMs);
  const maxBurstStrengthAbsolute = normalizeOptionalCap(options.maxBurstStrengthAbsolute);
  const maxBurstStrengthRelative = normalizeOptionalCap(options.maxBurstStrengthRelative);

  return [
    {
      name: 'require-device-connection',
      evaluate({ deviceState }) {
        if (!deviceState.connected) {
          return { type: 'deny', reason: '设备未连接' };
        }
        return null;
      },
    },
    {
      name: 'soft-start',
      evaluate({ command, deviceState }) {
        if (command.type !== 'start') return null;

        const current = command.channel === 'A' ? deviceState.strengthA : deviceState.strengthB;
        if (current > 0) return null;
        if (command.strength <= maxColdStartStrength) return null;

        return {
          type: 'clamp',
          command: { ...command, strength: maxColdStartStrength },
          reason: `冷启动强度上限为 ${maxColdStartStrength}`,
        };
      },
    },
    {
      name: 'user-strength-cap',
      evaluate({ command, deviceState }) {
        switch (command.type) {
          case 'start': {
            const effectiveLimit = getEffectiveLimit(command.channel, deviceState, {
              A: maxStrengthA,
              B: maxStrengthB,
            });
            if (command.strength <= effectiveLimit) return null;
            return {
              type: 'clamp',
              command: { ...command, strength: effectiveLimit },
              reason: `${command.channel} 通道强度上限为 ${effectiveLimit}`,
            };
          }
          case 'burst': {
            const effectiveLimit = getEffectiveLimit(command.channel, deviceState, {
              A: maxStrengthA,
              B: maxStrengthB,
            });
            if (command.strength <= effectiveLimit) return null;
            return {
              type: 'clamp',
              command: { ...command, strength: effectiveLimit },
              reason: `${command.channel} 通道 burst 强度上限为 ${effectiveLimit}`,
            };
          }
          case 'adjustStrength': {
            const current = command.channel === 'A' ? deviceState.strengthA : deviceState.strengthB;
            const effectiveLimit = getEffectiveLimit(command.channel, deviceState, {
              A: maxStrengthA,
              B: maxStrengthB,
            });
            const target = clamp(current + command.delta, 0, effectiveLimit);
            const clampedDelta = target - current;
            if (clampedDelta === command.delta) return null;
            return {
              type: 'clamp',
              command: { ...command, delta: clampedDelta },
              reason: `调整后的强度需遵守 ${command.channel} 通道上限 ${effectiveLimit}`,
            };
          }
          default:
            return null;
        }
      },
    },
    {
      name: 'burst-strength-cap',
      evaluate({ command, deviceState }) {
        if (command.type !== 'burst') return null;
        if (maxBurstStrengthAbsolute === 0 && maxBurstStrengthRelative === 0) return null;

        const current = command.channel === 'A' ? deviceState.strengthA : deviceState.strengthB;
        let cap = Number.POSITIVE_INFINITY;
        const reasons: string[] = [];
        if (maxBurstStrengthAbsolute > 0 && command.strength > maxBurstStrengthAbsolute) {
          cap = Math.min(cap, maxBurstStrengthAbsolute);
          reasons.push(`突增绝对强度上限 ${maxBurstStrengthAbsolute}`);
        }
        if (maxBurstStrengthRelative > 0) {
          const relativeCap = current + maxBurstStrengthRelative;
          if (command.strength > relativeCap) {
            cap = Math.min(cap, relativeCap);
            reasons.push(
              `突增相对强度上限 +${maxBurstStrengthRelative}（当前 ${current} → 不超过 ${relativeCap}）`,
            );
          }
        }
        if (!Number.isFinite(cap)) return null;

        return {
          type: 'clamp',
          command: { ...command, strength: cap },
          reason: reasons.join('；'),
        };
      },
    },
    {
      name: 'step-adjust',
      evaluate({ command }) {
        if (command.type !== 'adjustStrength') return null;
        if (Math.abs(command.delta) <= maxAdjustStep) return null;

        return {
          type: 'clamp',
          command: {
            ...command,
            delta: Math.sign(command.delta || 1) * maxAdjustStep,
          },
          reason: `单次调节幅度上限为 ±${maxAdjustStep}`,
        };
      },
    },
    {
      name: 'burst-duration',
      evaluate({ command }) {
        if (command.type !== 'burst') return null;
        if (command.durationMs <= maxBurstDurationMs) return null;

        return {
          type: 'clamp',
          command: {
            ...command,
            durationMs: maxBurstDurationMs,
          },
          reason: `Burst 时长上限为 ${maxBurstDurationMs}ms`,
        };
      },
    },
    {
      name: 'permission-gate',
      evaluate({ command }) {
        if (!requiresConfirmation(command)) return null;
        return {
          type: 'require-confirm',
          reason: '该操作会修改设备状态，需要先获取权限',
        };
      },
    },
  ];
}

function normalizeStrengthLimit(value: number | undefined): number {
  const raw = typeof value === 'number' ? value : DEFAULT_USER_MAX_STRENGTH;
  return clamp(raw, 0, 200);
}

function normalizeColdStartStrengthLimit(value: number | undefined): number {
  const raw = typeof value === 'number' ? value : DEFAULT_MAX_COLD_START_STRENGTH;
  return clamp(raw, 0, 200);
}

function normalizeAdjustStepLimit(value: number | undefined): number {
  const raw = typeof value === 'number' ? value : DEFAULT_MAX_ADJUST_STEP;
  return clamp(raw, 1, MAX_ADJUST_STEP_LIMIT);
}

function normalizeBurstDurationLimit(value: number | undefined): number {
  const raw = typeof value === 'number' ? value : DEFAULT_MAX_BURST_DURATION_MS;
  return clamp(raw, 100, MAX_BURST_DURATION_LIMIT_MS);
}

// 0 means "disabled" for the burst-specific caps. Negative input is
// coerced to 0 so a misconfigured slider can't widen the cap into the
// negative-strength territory.
function normalizeOptionalCap(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.round(value), 200);
}

function getEffectiveLimit(
  channel: 'A' | 'B',
  deviceState: { limitA: number; limitB: number },
  userLimits: { A: number; B: number },
): number {
  const hardware = channel === 'A' ? deviceState.limitA : deviceState.limitB;
  const user = userLimits[channel];
  return Math.min(hardware, user);
}

function clamp(value: number, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

export interface DefaultOpossumPolicyOptions {
  maxColdStartIntensity?: number;
  maxAdjustStep?: number;
}

function opossumRequiresConfirmation(command: OpossumCommand): boolean {
  return command.type !== 'vibrateStop';
}

/**
 * Mirrors `createDefaultPolicyRules` in spirit: require-connection first,
 * then a cold-start intensity clamp, then a step-adjust clamp, then a
 * permission gate. Deliberately narrower than Coyote's rule set — no
 * per-channel hardware limit (Opossum has no `limitA`/`limitB` concept) and
 * no burst-shaped caps (Opossum has no `burst` command).
 */
export function createDefaultOpossumPolicyRules(
  options: DefaultOpossumPolicyOptions = {},
): OpossumPolicyRule[] {
  const maxColdStartIntensity = normalizeOpossumIntensityLimit(
    options.maxColdStartIntensity,
    DEFAULT_MAX_OPOSSUM_COLD_START_INTENSITY,
  );
  const maxAdjustStep = normalizeOpossumAdjustStepLimit(options.maxAdjustStep);

  return [
    {
      name: 'require-opossum-connection',
      evaluate({ deviceState }) {
        if (!deviceState.connected) {
          return { type: 'deny', reason: '设备未连接' };
        }
        return null;
      },
    },
    {
      name: 'opossum-cold-start',
      evaluate({ command, deviceState }) {
        if (command.type !== 'vibrateStart') return null;

        const current = command.channel === 'A' ? deviceState.intensityA : deviceState.intensityB;
        if (current > 0) return null;
        if (command.intensity <= maxColdStartIntensity) return null;

        return {
          type: 'clamp',
          command: { ...command, intensity: maxColdStartIntensity },
          reason: `负鼠冷启动强度上限为 ${maxColdStartIntensity}`,
        };
      },
    },
    {
      name: 'opossum-step-adjust',
      evaluate({ command }) {
        if (command.type !== 'vibrateAdjust') return null;
        if (Math.abs(command.delta) <= maxAdjustStep) return null;

        return {
          type: 'clamp',
          command: {
            ...command,
            delta: Math.sign(command.delta || 1) * maxAdjustStep,
          },
          reason: `负鼠单次调节幅度上限为 ±${maxAdjustStep}`,
        };
      },
    },
    {
      name: 'opossum-permission-gate',
      evaluate({ command }) {
        if (!opossumRequiresConfirmation(command)) return null;
        return {
          type: 'require-confirm',
          reason: '该操作会修改设备状态，需要先获取权限',
        };
      },
    },
  ];
}

function normalizeOpossumIntensityLimit(value: number | undefined, fallback: number): number {
  const raw = typeof value === 'number' ? value : fallback;
  return clamp(raw, 0, 200);
}

function normalizeOpossumAdjustStepLimit(value: number | undefined): number {
  const raw = typeof value === 'number' ? value : DEFAULT_MAX_OPOSSUM_ADJUST_STEP;
  return clamp(raw, 1, MAX_ADJUST_STEP_LIMIT);
}
