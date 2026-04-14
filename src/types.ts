/** Coyote device state */
export interface DeviceState {
  connected: boolean;
  deviceName: string;
  address: string;
  battery: number;
  strengthA: number;
  strengthB: number;
  limitA: number;
  limitB: number;
  waveActiveA: boolean;
  waveActiveB: boolean;
}

/** Channel identifier */
export type Channel = 'A' | 'B';

/** A single waveform frame: [encoded_frequency, intensity] */
export type WaveFrame = [number, number];

/** A user-managed waveform in the library. */
export interface UserWaveform {
  id: string;
  name: string;
  description: string;
  frames: WaveFrame[];
}

/** Unified AI tool definition */
export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// Conversation item types — maps to OpenAI Responses API input/output
// ---------------------------------------------------------------------------

/** User message (easy format) */
export interface UserItem {
  role: 'user';
  content: string;
}

/** Assistant text message */
export interface AssistantItem {
  role: 'assistant';
  content: string;
}

/** Function call from AI response */
export interface FunctionCallItem {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

/** Function call result (created by client after tool execution) */
export interface FunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/** Any item in a conversation — can be passed directly as Responses API input */
export type ConversationItem = UserItem | AssistantItem | FunctionCallItem | FunctionCallOutputItem;

/** Extract displayable text from a conversation item */
export function getItemText(
  item: ConversationItem,
): { role: 'user' | 'assistant'; text: string } | null {
  if (!item) return null;
  const it = item as any;
  if (it.type === 'function_call' || it.type === 'function_call_output') return null;
  if (it.role === 'user') return { role: 'user', text: it.content };
  if (it.role === 'assistant') return { role: 'assistant', text: it.content };
  return null;
}

// ---------------------------------------------------------------------------
// Chat callbacks
// ---------------------------------------------------------------------------

/**
 * AgentSink — single sink for all UI-facing events emitted by the runner.
 * The runner does not know about UI state (msgIds, typing dots, etc).
 * The conversation layer implements a sink that translates these events
 * into concrete UI callback calls and manages bubble lifecycle internally.
 */
export interface AgentSink {
  /** A streamed text delta arrived. `accumulated` is the full text so far. */
  onTextDelta(accumulated: string): void;
  /** The current streamed assistant message is final and should be locked in. */
  onTextComplete(): void;
  /** The current streamed assistant message must be discarded entirely (hallucination guard). */
  onTextDiscard(): void;
  /**
   * Render a complete assistant message that was NOT produced via streaming
   * (e.g. the iteration-ceiling sentinel or a synthetic notice). The sink
   * creates a fresh bubble and finalizes it immediately.
   */
  onTextInline(text: string): void;
  /** A tool call was executed. Notification only — the result is already in the LLM input. */
  onToolCall(name: string, args: Record<string, unknown>, result: string): void;
}

// ---------------------------------------------------------------------------
// UI / config types
// ---------------------------------------------------------------------------

/** Scene prompt preset */
export interface PromptPreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  prompt: string;
}

/** Conversation record for persistence */
export interface ConversationRecord {
  id: string;
  title: string;
  items: ConversationItem[];
  presetId: string;
  createdAt: number;
  updatedAt: number;
}

/** Permission-prompt policy for AI-initiated tool calls. */
export type PermissionMode = 'ask' | 'timed' | 'always';

/** App settings persisted in localStorage */
export interface AppSettings {
  provider: string;
  configs: Record<string, Record<string, string>>;
  presetId: string;
  customPrompt: string;
  /** Behavior when app goes to background: 'stop' = stop all output, 'keep' = no change */
  backgroundBehavior?: 'stop' | 'keep';
  /** Hard upper bound on channel A output strength (0-200), enforced in-browser. */
  maxStrengthA?: number;
  /** Hard upper bound on channel B output strength (0-200), enforced in-browser. */
  maxStrengthB?: number;
  /** @deprecated legacy single-channel cap, migrated into maxStrengthA/B on load. */
  maxStrength?: number;
  /**
   * How permission prompts behave for mutating tool calls:
   *  - 'ask'    : show the dialog every call (default, safest)
   *  - 'timed'  : silent auto-allow for a rolling 5-minute window,
   *               auto-reverts to 'ask' on expiry
   *  - 'always' : silent auto-allow for every mutating call
   */
  permissionMode?: PermissionMode;
  /** Epoch-ms expiry for the 'timed' permission mode. Only read when permissionMode === 'timed'. */
  permissionModeExpiresAt?: number;
  /** Social platform bridge settings. */
  bridge?: {
    enabled: boolean;
    qq: {
      enabled: boolean;
      wsUrl: string;
      allowUsers: string[];
      allowGroups: string[];
      permissionMode: 'ask' | 'always';
    };
    telegram: {
      enabled: boolean;
      botToken: string;
      proxyUrl: string;
      allowUsers: number[];
      permissionMode: 'ask' | 'always';
    };
  };
  /** Voice I/O settings (real-time ASR + TTS via DashScope). */
  voice?: {
    speaker: string;
    /** Optional DashScope API Key for voice services. If empty, uses free proxy. */
    dashscopeApiKey: string;
    /** Optional custom WebSocket proxy URL. If empty, uses free proxy. */
    proxyUrl: string;
    /** Whether VAD auto-stop is enabled (default true). */
    autoStopEnabled: boolean;
  };
}

/** Provider field definition */
export interface ProviderField {
  key: string;
  label: string;
  type: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: string;
}

/** Provider definition for UI */
export interface ProviderDef {
  id: string;
  name: string;
  hint?: string;
  fields: ProviderField[];
}
