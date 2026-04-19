/**
 * agent/index.ts — Public barrel for the agent module.
 *
 * Only re-exports the symbols the UI layer actually consumes via this
 * barrel. Modules that live deeper (policies, runner, transport, permissions,
 * prompts, providers, tools) are imported directly by the code that needs
 * them — keeping this surface small makes it obvious what crosses the
 * agent/ui boundary.
 */

export * as bluetooth from './bluetooth';
export * as history from './history';
export * as conversation from './conversation';
export * as waveforms from './waveforms';
export { PROMPT_PRESETS } from './prompts';
export * as bridge from '../bridge';
