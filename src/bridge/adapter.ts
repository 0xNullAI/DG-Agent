/** Message received from a social platform */
export interface PlatformMessage {
  platform: string;
  userId: string;
  userName: string;
  text: string;
}

/** Abstract adapter for a social messaging platform */
export interface PlatformAdapter {
  readonly platform: string;
  /** Start the adapter (connect WS, start polling, etc.) */
  start(): Promise<void>;
  /** Stop the adapter cleanly */
  stop(): Promise<void>;
  /** Send a text message to a user */
  sendMessage(userId: string, text: string): Promise<void>;
  /** Register callback for incoming messages */
  onMessage(handler: (msg: PlatformMessage) => void): void;
  /** Wait for next message from a specific user (for permission dialog). Returns null on timeout. */
  waitForReply(userId: string, timeoutMs: number): Promise<string | null>;
  /** Whether the adapter is currently connected/running */
  readonly connected: boolean;
}
