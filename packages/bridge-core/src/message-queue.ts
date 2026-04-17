import type { MessageOrigin } from './bridge-types.js';

export class MessageQueue {
  private queue: Array<{ text: string; origin: MessageOrigin }> = [];
  private processing = false;
  private readonly processor: (text: string, origin: MessageOrigin) => Promise<void>;

  constructor(processor: (text: string, origin: MessageOrigin) => Promise<void>) {
    this.processor = processor;
  }

  enqueue(text: string, origin: MessageOrigin): void {
    this.queue.push({ text, origin });
    if (!this.processing) {
      void this.drain();
    }
  }

  get pending(): number {
    return this.queue.length;
  }

  private async drain(): Promise<void> {
    this.processing = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) continue;
      try {
        await this.processor(item.text, item.origin);
      } catch (error) {
        console.error('[BridgeQueue] processor error', error);
      }
    }
    this.processing = false;
  }
}
