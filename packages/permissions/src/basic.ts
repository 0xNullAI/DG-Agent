import type { PermissionService, PermissionRequest } from '@dg-agent/core';
import type { PermissionDecision } from '@dg-agent/core';

export class StaticPermissionService implements PermissionService {
  constructor(private readonly decision: PermissionDecision) {}

  async request(_input: PermissionRequest): Promise<PermissionDecision> {
    return this.decision;
  }
}

export class AllowAllPermissionService extends StaticPermissionService {
  constructor() {
    super({ type: 'approve-once' });
  }
}

export class DenyAllPermissionService extends StaticPermissionService {
  constructor() {
    super({ type: 'deny', reason: 'Denied by static permission service.' });
  }
}
