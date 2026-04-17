/// <reference types="vite/client" />

declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  readonly VITE_DEVICE_MODE?: 'fake' | 'web-bluetooth';
  readonly VITE_LLM_MODE?: 'fake' | 'provider-http';
  readonly VITE_PROVIDER_ID?: 'free' | 'qwen' | 'deepseek' | 'doubao' | 'openai' | 'custom';
  readonly VITE_OPENAI_API_KEY?: string;
  readonly VITE_OPENAI_BASE_URL?: string;
  readonly VITE_OPENAI_MODEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
