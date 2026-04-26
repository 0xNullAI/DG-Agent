/**
 * Tool registry — re-export of `@dg-kit/tools`.
 *
 * The actual tool definitions and execution-plan resolver live in DG-Kit so
 * DG-MCP and DG-Chat can share them. This file keeps the
 * `createDefaultToolRegistryWithDeps` name as a backward-compat alias for
 * existing callers (`agent-runtime.ts`).
 *
 * The runtime continues to enforce its own per-turn caps via
 * `runtime-tool-executor.ts` and `tool-call-config.ts`; the rate-limit policy
 * slot in `@dg-kit/tools` defaults to no-op here, so no behaviour changes.
 */

export {
  ToolRegistry,
  createDefaultToolRegistry,
  createDefaultToolRegistry as createDefaultToolRegistryWithDeps,
  createNoOpRateLimitPolicy,
  createSlidingWindowRateLimitPolicy,
  createTurnRateLimitPolicy,
  type DefaultToolRegistryDeps,
  type PerTurnOptions,
  type RateLimitPolicy,
  type SlidingWindowOptions,
  type ToolDefinitionHints,
  type ToolHandler,
} from '@dg-kit/tools';
