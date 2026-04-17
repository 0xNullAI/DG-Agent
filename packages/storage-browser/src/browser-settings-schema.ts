import { z } from 'zod';

const providerIds = ['free', 'qwen', 'deepseek', 'doubao', 'openai', 'custom'] as const;

export const settingsSchema = z.object({
  version: z.literal(1),
  themeMode: z.enum(['auto', 'dark', 'light']).optional(),
  showSafetyNoticeOnStartup: z.boolean().optional(),
  deviceMode: z.enum(['fake', 'web-bluetooth']).optional(),
  llmMode: z.enum(['fake', 'provider-http']).optional(),
  permissionMode: z.enum(['confirm', 'timed', 'allow-all']).optional(),
  permissionModeExpiresAt: z.number().int().positive().optional(),
  backgroundBehavior: z.enum(['stop', 'keep']).optional(),
  maxStrengthA: z.number().int().min(0).max(200).optional(),
  maxStrengthB: z.number().int().min(0).max(200).optional(),
  safetyStopOnLeave: z.boolean().optional(),
  rememberApiKey: z.boolean().optional(),
  voiceInputEnabled: z.boolean().optional(),
  ttsEnabled: z.boolean().optional(),
  voiceLanguage: z.string().min(2).optional(),
  voice: z
    .object({
      mode: z.enum(['browser', 'dashscope-proxy']).optional(),
      speaker: z.string().optional(),
      proxyUrl: z.string().optional(),
      autoStopEnabled: z.boolean().optional(),
    })
    .optional(),
  bridge: z
    .object({
      enabled: z.boolean(),
      qq: z.object({
        enabled: z.boolean(),
        wsUrl: z.string(),
        allowUsers: z.array(z.string()),
        allowGroups: z.array(z.string()),
        permissionMode: z.enum(['confirm', 'allow-all']),
      }),
      telegram: z.object({
        enabled: z.boolean(),
        botToken: z.string(),
        proxyUrl: z.string(),
        allowUsers: z.array(z.string()),
        permissionMode: z.enum(['confirm', 'allow-all']),
      }),
    })
    .optional(),
  promptPresetId: z.string().min(1).optional(),
  customPrompt: z.string().optional(),
  savedPromptPresets: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        prompt: z.string().min(1),
      }),
    )
    .optional(),
  provider: z
    .object({
      providerId: z.enum(providerIds),
      baseUrl: z.string(),
      model: z.string(),
      endpoint: z.enum(['responses', 'chat/completions']),
      useStrict: z.boolean(),
    })
    .optional(),
  providerConfigs: z
    .record(
      z.string(),
      z.object({
        providerId: z.enum(providerIds),
        baseUrl: z.string(),
        model: z.string(),
        endpoint: z.enum(['responses', 'chat/completions']),
        useStrict: z.boolean(),
      }),
    )
    .optional(),
});

export type PersistedBrowserAppSettings = z.infer<typeof settingsSchema>;
