import type { PromptPreset, SavedPromptPreset } from './types.js';
import { gentlePreset } from './presets/gentle.js';
import { dominantPreset } from './presets/dominant.js';
import { teasePreset } from './presets/tease.js';
import { rewardPreset } from './presets/reward.js';
import { edgingPreset } from './presets/edging.js';
import { companionPreset } from './presets/companion.js';
import { hellIslandPreset } from './presets/hell-island.js';

export const BUILTIN_PROMPT_PRESETS: PromptPreset[] = [
  gentlePreset,
  dominantPreset,
  teasePreset,
  rewardPreset,
  edgingPreset,
  companionPreset,
  hellIslandPreset,
];

export function getBuiltinPromptPresetById(id: string): PromptPreset | undefined {
  return BUILTIN_PROMPT_PRESETS.find((preset) => preset.id === id);
}

export function getAnyPromptPresetById(
  id: string,
  savedPresets: SavedPromptPreset[],
): PromptPreset | SavedPromptPreset | undefined {
  return savedPresets.find((preset) => preset.id === id) ?? getBuiltinPromptPresetById(id);
}
