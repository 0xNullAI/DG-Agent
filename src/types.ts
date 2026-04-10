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

/** Waveform preset name */
export type WavePreset = 'breath' | 'tide' | 'pulse_low' | 'pulse_mid' | 'pulse_high' | 'tap';

/** A single waveform frame: [encoded_frequency, intensity] */
export type WaveFrame = [number, number];

/** Custom wave step descriptor */
export interface WaveStep {
  freq: number;
  intensity: number;
  repeat?: number;
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
export type ConversationItem =
  | UserItem
  | AssistantItem
  | FunctionCallItem
  | FunctionCallOutputItem;

/** Extract displayable text from a conversation item */
export function getItemText(item: ConversationItem): { role: 'user' | 'assistant'; text: string } | null {
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

/** Callbacks for the AI chat function */
export interface ChatCallbacks {
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<string>;
  onStreamText?: (chunk: string) => void;
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

/** Saved custom prompt */
export interface SavedPrompt {
  id: string;
  name: string;
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

/** App settings persisted in localStorage */
export interface AppSettings {
  provider: string;
  configs: Record<string, Record<string, string>>;
  presetId: string;
  customPrompt: string;
  /** Behavior when app goes to background: 'stop' = stop all output, 'keep' = no change */
  backgroundBehavior?: 'stop' | 'keep';
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
