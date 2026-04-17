import type { PermissionPort, PermissionRequest } from '@dg-agent/contracts';
import type { PermissionDecision } from '@dg-agent/core';

export class StaticPermissionPort implements PermissionPort {
  constructor(private readonly decision: PermissionDecision) {}

  async request(_input: PermissionRequest): Promise<PermissionDecision> {
    return this.decision;
  }
}

export class AllowAllPermissionPort extends StaticPermissionPort {
  constructor() {
    super({ type: 'approve-once' });
  }
}

export class DenyAllPermissionPort extends StaticPermissionPort {
  constructor() {
    super({ type: 'deny', reason: 'Denied by static permission port.' });
  }
}
