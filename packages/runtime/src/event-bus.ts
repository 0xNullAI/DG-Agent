import type { RuntimeEvent } from '@dg-agent/core';

export type RuntimeListener = (event: RuntimeEvent) => void;

export class InMemoryEventBus {
  private listeners = new Set<RuntimeListener>();

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

