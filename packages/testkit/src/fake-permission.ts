import type { PermissionPort, PermissionRequest } from '@dg-agent/contracts';
import type { PermissionDecision } from '@dg-agent/core';

export class FakePermissionPort implements PermissionPort {
  constructor(private readonly decision: PermissionDecision = { type: 'approve-once' }) {}

  async request(_input: PermissionRequest): Promise<PermissionDecision> {
    return this.decision;
  }
}
