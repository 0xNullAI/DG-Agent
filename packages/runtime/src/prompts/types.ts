export interface PromptPreset {
  id: string;
  name: string;
  icon?: string;
  description: string;
  prompt: string;
}

export interface SavedPromptPreset {
  id: string;
  name: string;
  icon?: string;
  prompt: string;
}
