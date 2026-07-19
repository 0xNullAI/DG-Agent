import type {
  ActionContext,
  DeviceCommand,
  DeviceState,
  OpossumCommand,
  PolicyDecision,
} from '@dg-agent/core';
import type { OpossumState } from '@dg-kit/protocol';

export interface EvaluatePolicyInput {
  context: ActionContext;
  command: DeviceCommand;
  deviceState: DeviceState;
}

export interface PolicyRule {
  name: string;
  evaluate(input: EvaluatePolicyInput): PolicyDecision | null;
}

export class PolicyEngine {
  constructor(private readonly rules: PolicyRule[]) {}

  evaluate(input: EvaluatePolicyInput): PolicyDecision {
    for (const rule of this.rules) {
      const result = rule.evaluate(input);
      if (result) {
        return result;
      }
    }

    return { type: 'allow' };
  }
}

// ---------------------------------------------------------------------------
// Opossum (vibration controller) policy engine.
//
// `OpossumCommand`/`OpossumState` are a deliberately separate shape from
// `DeviceCommand`/`DeviceState` (see @dg-kit/core's OpossumCommand doc
// comment), so they get a parallel, small policy engine here rather than
// genericizing `PolicyEngine`/`PolicyRule`/`PolicyDecision` — those are
// exported from @dg-agent/core and used elsewhere keyed to the Coyote
// shape; forcing a generic through them would be a bigger, riskier change
// than duplicating ~20 lines of loop logic.
// ---------------------------------------------------------------------------

export type OpossumPolicyDecision =
  | { type: 'allow' }
  | { type: 'deny'; reason: string }
  | { type: 'clamp'; command: OpossumCommand; reason: string }
  | { type: 'require-confirm'; reason: string };

export interface EvaluateOpossumPolicyInput {
  context: ActionContext;
  command: OpossumCommand;
  deviceState: OpossumState;
}

export interface OpossumPolicyRule {
  name: string;
  evaluate(input: EvaluateOpossumPolicyInput): OpossumPolicyDecision | null;
}

export class OpossumPolicyEngine {
  constructor(private readonly rules: OpossumPolicyRule[]) {}

  evaluate(input: EvaluateOpossumPolicyInput): OpossumPolicyDecision {
    for (const rule of this.rules) {
      const result = rule.evaluate(input);
      if (result) {
        return result;
      }
    }

    return { type: 'allow' };
  }
}
