import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PROMPT_PRESETS,
  getBuiltinPromptPresetById,
  getAnyPromptPresetById,
} from './index.js';

describe('BUILTIN_PROMPT_PRESETS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(BUILTIN_PROMPT_PRESETS)).toBe(true);
    expect(BUILTIN_PROMPT_PRESETS.length).toBeGreaterThan(0);
  });

  it('every preset has non-empty id, name, and prompt', () => {
    for (const preset of BUILTIN_PROMPT_PRESETS) {
      expect(typeof preset.id).toBe('string');
      expect(preset.id.length).toBeGreaterThan(0);
      expect(typeof preset.name).toBe('string');
      expect(preset.name.length).toBeGreaterThan(0);
      expect(typeof preset.prompt).toBe('string');
      expect(preset.prompt.length).toBeGreaterThan(0);
    }
  });

  it('all preset ids are unique', () => {
    const ids = BUILTIN_PROMPT_PRESETS.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});

describe('getBuiltinPromptPresetById', () => {
  it('returns the correct preset for a known id', () => {
    const first = BUILTIN_PROMPT_PRESETS[0]!;
    const result = getBuiltinPromptPresetById(first.id);
    expect(result).toBeDefined();
    expect(result?.id).toBe(first.id);
    expect(result?.name).toBe(first.name);
  });

  it('returns undefined for an unknown id', () => {
    expect(getBuiltinPromptPresetById('__nonexistent__')).toBeUndefined();
  });
});

describe('getAnyPromptPresetById', () => {
  it('returns a saved preset when id matches', () => {
    const saved = [{ id: 'custom-1', name: 'My Custom', prompt: 'custom prompt' }];
    const result = getAnyPromptPresetById('custom-1', saved);
    expect(result?.id).toBe('custom-1');
    expect(result?.name).toBe('My Custom');
  });

  it('falls back to builtin when saved preset not found', () => {
    const first = BUILTIN_PROMPT_PRESETS[0]!;
    const result = getAnyPromptPresetById(first.id, []);
    expect(result?.id).toBe(first.id);
  });

  it('returns undefined when neither saved nor builtin matches', () => {
    expect(getAnyPromptPresetById('__nonexistent__', [])).toBeUndefined();
  });
});
