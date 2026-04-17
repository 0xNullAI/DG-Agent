import type { DeviceCommand } from '@dg-agent/core';
import type { PolicyRule } from './policy-engine.js';

const MAX_COLD_START_STRENGTH = 10;
const MAX_ADJUST_STEP = 10;
const MAX_BURST_DURATION_MS = 5_000;
const DEFAULT_USER_MAX_STRENGTH = 50;

export interface DefaultPolicyOptions {
  maxStrengthA?: number;
  maxStrengthB?: number;
}

function requiresConfirmation(command: DeviceCommand): boolean {
  return command.type !== 'stop' && command.type !== 'emergencyStop';
}

export function createDefaultPolicyRules(options: DefaultPolicyOptions = {}): PolicyRule[] {
  const maxStrengthA = normalizeStrengthLimit(options.maxStrengthA);
  const maxStrengthB = normalizeStrengthLimit(options.maxStrengthB);

  return [
    {
      name: 'require-device-connection',
      evaluate({ deviceState }) {
        if (!deviceState.connected) {
          return { type: 'deny', reason: 'Device is not connected.' };
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
        if (command.strength <= MAX_COLD_START_STRENGTH) return null;

        return {
          type: 'clamp',
          command: { ...command, strength: MAX_COLD_START_STRENGTH },
          reason: `Cold-start strength is capped at ${MAX_COLD_START_STRENGTH}.`,
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
              reason: `Channel ${command.channel} is limited to ${effectiveLimit}.`,
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
              reason: `Burst on channel ${command.channel} is limited to ${effectiveLimit}.`,
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
              reason: `Adjusted strength respects the channel ${command.channel} limit of ${effectiveLimit}.`,
            };
          }
          default:
            return null;
        }
      },
    },
    {
      name: 'step-adjust',
      evaluate({ command }) {
        if (command.type !== 'adjustStrength') return null;
        if (Math.abs(command.delta) <= MAX_ADJUST_STEP) return null;

        return {
          type: 'clamp',
          command: {
            ...command,
            delta: Math.sign(command.delta || 1) * MAX_ADJUST_STEP,
          },
          reason: `Single-step adjustment is capped at ±${MAX_ADJUST_STEP}.`,
        };
      },
    },
    {
      name: 'burst-duration',
      evaluate({ command }) {
        if (command.type !== 'burst') return null;
        if (command.durationMs <= MAX_BURST_DURATION_MS) return null;

        return {
          type: 'clamp',
          command: {
            ...command,
            durationMs: MAX_BURST_DURATION_MS,
          },
          reason: `Burst duration is capped at ${MAX_BURST_DURATION_MS}ms.`,
        };
      },
    },
    {
      name: 'permission-gate',
      evaluate({ command }) {
        if (!requiresConfirmation(command)) return null;
        return {
          type: 'require-confirm',
          reason: 'A mutating action requires permission.',
        };
      },
    },
  ];
}

export function summarizeCommand(command: DeviceCommand): string {
  switch (command.type) {
    case 'start':
      return `Start channel ${command.channel} at strength ${command.strength} with waveform ${command.waveform.id}`;
    case 'stop':
      return command.channel ? `Stop channel ${command.channel}` : 'Stop all channels';
    case 'adjustStrength':
      return `Adjust channel ${command.channel} by ${command.delta > 0 ? '+' : ''}${command.delta}`;
    case 'changeWave':
      return `Change channel ${command.channel} to waveform ${command.waveform.id}`;
    case 'burst':
      return `Burst channel ${command.channel} to ${command.strength} for ${command.durationMs}ms`;
    case 'emergencyStop':
      return 'Emergency stop';
  }
}

function normalizeStrengthLimit(value: number | undefined): number {
  const raw = typeof value === 'number' ? value : DEFAULT_USER_MAX_STRENGTH;
  return clamp(raw, 0, 200);
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
