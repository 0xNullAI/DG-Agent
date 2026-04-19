/** Origin metadata attached to each queued message */
export interface MessageOrigin {
  platform: string;
  userId: string;
  userName: string;
}

/**
 * Async FIFO queue that serializes message processing.
 *
 * Messages are enqueued via `enqueue()` and drained one at a time —
 * the next message only begins processing after the previous processor
 * call resolves.
 */
export class MessageQueue {
  private queue: Array<{ text: string; origin: MessageOrigin }> = [];
  private processing = false;
  private readonly processor: (text: string, origin: MessageOrigin) => Promise<void>;

  constructor(processor: (text: string, origin: MessageOrigin) => Promise<void>) {
    this.processor = processor;
  }

  /** Number of messages waiting (not including the one currently processing) */
  get pending(): number {
    return this.queue.length;
  }

  /** Add a message to the queue. Starts draining if idle. */
  enqueue(text: string, origin: MessageOrigin): void {
    this.queue.push({ text, origin });
    if (!this.processing) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      try {
        await this.processor(item.text, item.origin);
      } catch (err) {
        console.error('[MessageQueue] processor error:', err);
      }
    }
    this.processing = false;
  }
}
