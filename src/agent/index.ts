/**
 * agent/index.ts — Public API for the agent module.
 */

export * as bluetooth from './bluetooth';
export * as aiService from './ai-service';
export * as history from './history';
export * as conversation from './conversation';
export { PROMPT_PRESETS, DEFAULT_PRESET_ID, buildSystemPrompt, getDeviceSuffix } from './prompts';
export { tools, executeTool } from './tools';
export { PROVIDERS, loadSettings, saveSettings } from './providers';
