import type { ActionContext, DeviceCommand, DeviceState, PolicyDecision } from '@dg-agent/core';

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
