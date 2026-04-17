import type { DevicePort } from '@dg-agent/contracts';
import { createEmptyDeviceState, type DeviceCommand, type DeviceCommandResult, type DeviceState } from '@dg-agent/core';

export class FakeDevicePort implements DevicePort {
  private state: DeviceState = createEmptyDeviceState();
  private listeners = new Set<(state: DeviceState) => void>();

  async connect(): Promise<void> {
    this.state = { ...this.state, connected: true };
    this.emit();
  }

  async disconnect(): Promise<void> {
    this.state = createEmptyDeviceState();
    this.emit();
  }

  async getState(): Promise<DeviceState> {
    return this.state;
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    switch (command.type) {
      case 'start': {
        const next = { ...this.state };
        if (command.channel === 'A') {
          next.strengthA = command.strength;
          next.waveActiveA = true;
          next.currentWaveA = command.waveform.id;
        } else {
          next.strengthB = command.strength;
          next.waveActiveB = true;
          next.currentWaveB = command.waveform.id;
        }
        this.state = next;
        break;
      }
      case 'stop': {
        const next = { ...this.state };
        if (!command.channel || command.channel === 'A') {
          next.strengthA = 0;
          next.waveActiveA = false;
          next.currentWaveA = undefined;
        }
        if (!command.channel || command.channel === 'B') {
          next.strengthB = 0;
          next.waveActiveB = false;
          next.currentWaveB = undefined;
        }
        this.state = next;
        break;
      }
      case 'adjustStrength': {
        const next = { ...this.state };
        if (command.channel === 'A') {
          next.strengthA = Math.min(next.limitA, Math.max(0, next.strengthA + command.delta));
          next.waveActiveA = next.strengthA > 0;
        } else {
          next.strengthB = Math.min(next.limitB, Math.max(0, next.strengthB + command.delta));
          next.waveActiveB = next.strengthB > 0;
        }
        this.state = next;
        break;
      }
      case 'changeWave': {
        const next = { ...this.state };
        if (command.channel === 'A') {
          next.currentWaveA = command.waveform.id;
          next.waveActiveA = true;
        } else {
          next.currentWaveB = command.waveform.id;
          next.waveActiveB = true;
        }
        this.state = next;
        break;
      }
      case 'burst': {
        const next = { ...this.state };
        if (command.channel === 'A') {
          next.strengthA = Math.min(next.limitA, command.strength);
          next.waveActiveA = true;
        } else {
          next.strengthB = Math.min(next.limitB, command.strength);
          next.waveActiveB = true;
        }
        this.state = next;
        break;
      }
      case 'emergencyStop': {
        await this.emergencyStop();
        break;
      }
    }

    this.emit();
    return { state: this.state };
  }

  async emergencyStop(): Promise<void> {
    this.state = {
      ...this.state,
      strengthA: 0,
      strengthB: 0,
      waveActiveA: false,
      waveActiveB: false,
      currentWaveA: undefined,
      currentWaveB: undefined,
    };
    this.emit();
  }

  onStateChanged(listener: (state: DeviceState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
