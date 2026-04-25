import type { Channel } from '@dg-agent/core';
import {
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import {
  BaseCoyoteProtocolAdapter,
  INACTIVE_FREQ,
  INACTIVE_INT,
  type Quad,
  type WebBluetoothConnectionContext,
} from './coyote-protocol-base.js';
import type { BluetoothRemoteGATTCharacteristicLike } from './types.js';

export class CoyoteV3ProtocolAdapter extends BaseCoyoteProtocolAdapter {
  protected writeChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  protected notifyChar: BluetoothRemoteGATTCharacteristicLike | null = null;

  protected seq = 0;
  protected pendingMode = 0;
  protected pendingStrA = 0;
  protected pendingStrB = 0;
  protected awaitingAck = false;

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    await this.resetConnectionState({ emit: false });
    try {
      this.setConnectedDevice(context.device);

      const primaryService = await context.server.getPrimaryService(V3_PRIMARY_SERVICE);
      this.writeChar = await primaryService.getCharacteristic(V3_WRITE_CHAR);
      this.notifyChar = await primaryService.getCharacteristic(V3_NOTIFY_CHAR);
      await this.notifyChar.startNotifications();
      this.notifyChar.addEventListener('characteristicvaluechanged', this.handleV3Notification);

      try {
        const batteryService = await context.server.getPrimaryService(V3_BATTERY_SERVICE);
        this.batteryChar = await batteryService.getCharacteristic(V3_BATTERY_CHAR);
        await this.readBattery();
      } catch {
        this.state.battery = 0;
      }

      this.resetProtocolState();
      if (!this.writeChar || !this.notifyChar) {
        throw new Error('V3 transport characteristics unavailable');
      }
      await this.writeBF(this.state.limitA, this.state.limitB);
      this.pendingMode = (3 << 2) | 3;
      this.pendingStrA = 0;
      this.pendingStrB = 0;
      this.startProtocolLoop();
    } catch (error) {
      await this.resetConnectionState({ emit: false });
      throw error;
    }
  }

  protected async disconnectProtocol(): Promise<void> {
    if (this.notifyChar) {
      this.notifyChar.removeEventListener('characteristicvaluechanged', this.handleV3Notification);
      try {
        await this.notifyChar.stopNotifications();
      } catch {
        // ignore
      }
    }

    this.writeChar = null;
    this.notifyChar = null;
  }

  protected resetProtocolState(): void {
    this.seq = 0;
    this.pendingMode = 0;
    this.pendingStrA = 0;
    this.pendingStrB = 0;
    this.awaitingAck = false;
    this.resetWaveState();
  }

  protected resetEmergencyStopState(): void {
    this.pendingStrA = 0;
    this.pendingStrB = 0;
    this.awaitingAck = false;
    this.seq = 0;
    this.pendingMode = 0;
  }

  protected setAbsoluteStrength(channel: Channel, value: number): void {
    const next = this.clamp(value, 0, 200);

    if (channel === 'A') {
      this.pendingStrA = next;
      this.state.strengthA = next;
      this.pendingMode = (this.pendingMode & 0x03) | (3 << 2);
    } else {
      this.pendingStrB = next;
      this.state.strengthB = next;
      this.pendingMode = (this.pendingMode & 0x0c) | 3;
    }
  }

  protected adjustStrength(channel: Channel, delta: number): void {
    const next =
      channel === 'A'
        ? this.clamp(this.state.strengthA + this.toInt(delta), 0, 200)
        : this.clamp(this.state.strengthB + this.toInt(delta), 0, 200);

    const signedDelta = this.toInt(delta, 0);
    const mode = signedDelta >= 0 ? 1 : 2;
    const magnitude = this.clamp(Math.abs(signedDelta), 0, 200);
    if (channel === 'A') {
      this.pendingStrA = magnitude;
      this.state.strengthA = next;
      this.pendingMode = (this.pendingMode & 0x03) | (mode << 2);
    } else {
      this.pendingStrB = magnitude;
      this.state.strengthB = next;
      this.pendingMode = (this.pendingMode & 0x0c) | mode;
    }
  }

  protected async performTick(): Promise<void> {
    if (!this.writeChar) return;
    await this.writeCharacteristicValue(this.writeChar, this.buildB0());
  }

  protected async writeEmergencyStopPacket(): Promise<void> {
    if (!this.writeChar) return;
    try {
      await this.writeCharacteristicValue(
        this.writeChar,
        this.buildImmediateAbsoluteStrengthPacket(0, 0),
      );
    } catch {
      // ignore best effort
    }
  }

  private buildB0(): Uint8Array {
    const buffer = new Uint8Array(20);
    buffer[0] = 0xb0;

    let modeNibble = 0;
    const strengthA = this.pendingStrA;
    const strengthB = this.pendingStrB;

    if (!this.awaitingAck && this.pendingMode !== 0) {
      this.seq = this.nextSeq();
      modeNibble = this.pendingMode;
      this.awaitingAck = true;
      this.pendingMode = 0;
    }

    buffer[1] = ((this.seq & 0x0f) << 4) | (modeNibble & 0x0f);
    buffer[2] = this.clamp(strengthA, 0, 200);
    buffer[3] = this.clamp(strengthB, 0, 200);

    const channelA = this.advanceWavePacket('A');
    const channelB = this.advanceWavePacket('B');

    buffer.set(channelA.freq, 4);
    buffer.set(channelA.int, 8);
    buffer.set(channelB.freq, 12);
    buffer.set(channelB.int, 16);

    return buffer;
  }

  private buildImmediateAbsoluteStrengthPacket(strengthA: number, strengthB: number): Uint8Array {
    const buffer = new Uint8Array(20);
    buffer[0] = 0xb0;
    buffer[1] = 0x0f;
    buffer[2] = this.clamp(strengthA, 0, 200);
    buffer[3] = this.clamp(strengthB, 0, 200);
    buffer.set(INACTIVE_FREQ, 4);
    buffer.set(INACTIVE_INT, 8);
    buffer.set(INACTIVE_FREQ, 12);
    buffer.set(INACTIVE_INT, 16);
    return buffer;
  }

  private buildBF(limitA: number, limitB: number): Uint8Array {
    const buffer = new Uint8Array(7);
    buffer[0] = 0xbf;
    buffer[1] = this.clamp(limitA, 0, 200);
    buffer[2] = this.clamp(limitB, 0, 200);
    buffer[3] = 160;
    buffer[4] = 160;
    buffer[5] = 0;
    buffer[6] = 0;
    return buffer;
  }

  private async writeBF(limitA: number, limitB: number): Promise<void> {
    if (!this.writeChar) return;
    await this.writeCharacteristicValue(this.writeChar, this.buildBF(limitA, limitB));
  }

  private nextSeq(): number {
    return this.seq >= 15 ? 1 : this.seq + 1;
  }

  readonly handleV3Notification = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
    const value = target?.value;
    if (!value || value.byteLength < 4) return;
    if (value.getUint8(0) !== 0xb1) return;

    const ackSeq = value.getUint8(1);
    const nextStrengthA = value.getUint8(2);
    const nextStrengthB = value.getUint8(3);

    if (this.shouldIgnoreStaleStopStrengthNotification(nextStrengthA, nextStrengthB)) {
      return;
    }

    this.state.strengthA = nextStrengthA;
    this.state.strengthB = nextStrengthB;

    if (this.awaitingAck && ackSeq === this.seq) {
      this.awaitingAck = false;
      this.seq = 0;
    }

    this.emit();
  };
}
