import { z } from 'zod';

const providerIds = ['free', 'qwen', 'deepseek', 'doubao', 'openai', 'custom'] as const;

export const settingsSchema = z.object({
  version: z.literal(1),
  themeMode: z.enum(['auto', 'dark', 'light']).optional(),
  showSafetyNoticeOnStartup: z.boolean().optional(),
  deviceMode: z.enum(['fake', 'web-bluetooth']).optional(),
  llmMode: z.enum(['fake', 'provider-http']).optional(),
  modelContextStrategy: z
    .enum(['last-user-turn', 'last-five-user-turns', 'full-history'])
    .optional(),
  permissionMode: z.enum(['confirm', 'timed', 'allow-all']).optional(),
  permissionModeExpiresAt: z.number().int().positive().optional(),
  backgroundBehavior: z.enum(['stop', 'keep']).optional(),
  maxStrengthA: z.number().int().min(0).max(200).optional(),
  maxStrengthB: z.number().int().min(0).max(200).optional(),
  maxColdStartStrength: z.number().int().min(0).max(200).optional(),
  maxToolIterations: z.number().int().min(1).optional(),
  maxToolCallsPerTurn: z.number().int().min(1).optional(),
  maxAdjustStrengthCallsPerTurn: z.number().int().min(1).optional(),
  maxAdjustStrengthStep: z.number().int().min(1).max(200).optional(),
  maxBurstCallsPerTurn: z.number().int().min(1).optional(),
  maxBurstDurationMs: z.number().int().min(100).max(20000).optional(),
  burstRequiresActiveChannel: z.boolean().optional(),
  safetyStopOnLeave: z.boolean().optional(),
  rememberApiKey: z.boolean().optional(),
  modelLogEnabled: z.boolean().optional(),
  speechRecognitionEnabled: z.boolean().optional(),
  speechSynthesisEnabled: z.boolean().optional(),
  speechRecognitionLanguage: z.string().min(2).optional(),
  speechSynthesisLanguage: z.string().min(2).optional(),
  speechLanguage: z.string().min(2).optional(),
  voiceInputEnabled: z.boolean().optional(),
  ttsEnabled: z.boolean().optional(),
  voiceLanguage: z.string().min(2).optional(),
  voice: z
    .object({
      mode: z.enum(['browser', 'dashscope-proxy']).optional(),
      speaker: z.string().optional(),
      browserVoiceUri: z.string().optional(),
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
        accessToken: z.string().optional(),
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
  savedPromptPresets: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        icon: z.string().optional(),
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
