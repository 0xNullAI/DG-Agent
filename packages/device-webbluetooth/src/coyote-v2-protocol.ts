import type { Channel } from '@dg-agent/core';
import {
  V2_BATTERY_CHAR,
  V2_BATTERY_SERVICE,
  V2_PRIMARY_SERVICE,
  V2_STRENGTH_CHAR,
  V2_WAVE_A_CHAR,
  V2_WAVE_B_CHAR,
} from './constants.js';
import {
  BaseCoyoteProtocolAdapter,
  type WebBluetoothConnectionContext,
} from './coyote-protocol-base.js';
import type { BluetoothRemoteGATTCharacteristicLike } from './types.js';

export class CoyoteV2ProtocolAdapter extends BaseCoyoteProtocolAdapter {
  protected v2StrengthChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  protected v2WaveAChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  protected v2WaveBChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  protected pendingStrA = 0;
  protected pendingStrB = 0;

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    await this.resetConnectionState({ emit: false });
    try {
      this.setConnectedDevice(context.device);

      const primaryService = await context.server.getPrimaryService(V2_PRIMARY_SERVICE);
      this.v2StrengthChar = await primaryService.getCharacteristic(V2_STRENGTH_CHAR);
      this.v2WaveAChar = await primaryService.getCharacteristic(V2_WAVE_A_CHAR);
      this.v2WaveBChar = await primaryService.getCharacteristic(V2_WAVE_B_CHAR);
      await this.v2StrengthChar.startNotifications();
      this.v2StrengthChar.addEventListener(
        'characteristicvaluechanged',
        this.handleV2StrengthNotification,
      );

      try {
        const batteryService = await context.server.getPrimaryService(V2_BATTERY_SERVICE);
        this.batteryChar = await batteryService.getCharacteristic(V2_BATTERY_CHAR);
        await this.readBattery();
      } catch {
        this.state.battery = 0;
      }
    } catch (error) {
      await this.resetConnectionState({ emit: false });
      throw error;
    }

    try {
      if (!this.v2StrengthChar) {
        throw new Error('V2 strength characteristic unavailable');
      }
      if (!this.v2WaveAChar || !this.v2WaveBChar) {
        throw new Error('V2 wave characteristics unavailable');
      }

      this.resetProtocolState();
      await this.writeCharacteristicValue(this.v2StrengthChar, this.encodeV2Strength(0, 0), {
        preferResponse: true,
      });
      this.startProtocolLoop();
    } catch (error) {
      await this.resetConnectionState({ emit: false });
      throw error;
    }
  }

  protected async disconnectProtocol(): Promise<void> {
    if (this.v2StrengthChar) {
      this.v2StrengthChar.removeEventListener(
        'characteristicvaluechanged',
        this.handleV2StrengthNotification,
      );
      try {
        await this.v2StrengthChar.stopNotifications();
      } catch {
        // ignore
      }
    }

    this.v2StrengthChar = null;
    this.v2WaveAChar = null;
    this.v2WaveBChar = null;
  }

  protected resetProtocolState(): void {
    this.pendingStrA = 0;
    this.pendingStrB = 0;
    this.resetWaveState();
  }

  protected resetEmergencyStopState(): void {
    this.pendingStrA = 0;
    this.pendingStrB = 0;
  }

  protected setAbsoluteStrength(channel: Channel, value: number): void {
    const next = this.clamp(value, 0, 200);
    if (channel === 'A') {
      this.pendingStrA = next;
      this.state.strengthA = next;
    } else {
      this.pendingStrB = next;
      this.state.strengthB = next;
    }
  }

  protected adjustStrength(channel: Channel, delta: number): void {
    const next =
      channel === 'A'
        ? this.clamp(this.state.strengthA + this.toInt(delta), 0, 200)
        : this.clamp(this.state.strengthB + this.toInt(delta), 0, 200);
    this.setAbsoluteStrength(channel, next);
  }

  protected async performTick(): Promise<void> {
    if (!this.v2StrengthChar) return;

    const strengthA = Math.min(this.pendingStrA, this.state.limitA);
    const strengthB = Math.min(this.pendingStrB, this.state.limitB);

    await this.writeCharacteristicValue(
      this.v2StrengthChar,
      this.encodeV2Strength(strengthA, strengthB),
      { preferResponse: true },
    );
    this.state.strengthA = strengthA;
    this.state.strengthB = strengthB;

    if (this.v2WaveAChar) {
      const next = this.advanceWaveStep('A');
      if (!next) {
        await this.writeCharacteristicValue(this.v2WaveAChar, this.encodeV2Wave(0, 0, 0), {
          preferResponse: true,
        });
      } else {
        const params = this.waveFrameToV2(next.freq, next.int);
        await this.writeCharacteristicValue(
          this.v2WaveAChar,
          this.encodeV2Wave(params.x, params.y, params.z),
          { preferResponse: true },
        );
      }
    }

    if (this.v2WaveBChar) {
      const next = this.advanceWaveStep('B');
      if (!next) {
        await this.writeCharacteristicValue(this.v2WaveBChar, this.encodeV2Wave(0, 0, 0), {
          preferResponse: true,
        });
      } else {
        const params = this.waveFrameToV2(next.freq, next.int);
        await this.writeCharacteristicValue(
          this.v2WaveBChar,
          this.encodeV2Wave(params.x, params.y, params.z),
          { preferResponse: true },
        );
      }
    }
  }

  protected async writeEmergencyStopPacket(): Promise<void> {
    if (!this.v2StrengthChar) return;
    try {
      await this.writeCharacteristicValue(this.v2StrengthChar, this.encodeV2Strength(0, 0), {
        preferResponse: true,
      });
    } catch {
      // ignore best effort
    }
  }

  private encodeV2Strength(a: number, b: number): Uint8Array {
    const valueA = Math.round((this.clamp(a, 0, 200) * 2047) / 200);
    const valueB = Math.round((this.clamp(b, 0, 200) * 2047) / 200);
    const combined = (valueA << 11) | valueB;
    return new Uint8Array([(combined >> 16) & 0xff, (combined >> 8) & 0xff, combined & 0xff]);
  }

  private encodeV2Wave(x: number, y: number, z: number): Uint8Array {
    const packed = ((z & 0x1f) << 15) | ((y & 0x3ff) << 5) | (x & 0x1f);
    return new Uint8Array([(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff]);
  }

  private decodeV3Freq(encoded: number): number {
    if (encoded <= 100) return encoded;
    if (encoded <= 200) return (encoded - 100) * 5 + 100;
    return (encoded - 200) * 10 + 600;
  }

  private waveFrameToV2(freq: number, intensity: number): { x: number; y: number; z: number } {
    const periodMs = this.decodeV3Freq(freq);
    const x = this.clamp(Math.round(Math.sqrt(periodMs / 1000) * 15), 1, 31);
    return {
      x,
      y: this.clamp(periodMs - x, 0, 1023),
      z: this.clamp(Math.round((intensity * 31) / 100), 0, 31),
    };
  }

  readonly handleV2StrengthNotification = (event: Event): void => {
    const target = event.target as BluetoothRemoteGATTCharacteristicLike | null;
    const value = target?.value;
    if (!value || value.byteLength < 3) return;

    const raw = (value.getUint8(0) << 16) | (value.getUint8(1) << 8) | value.getUint8(2);
    const rawA = (raw >> 11) & 0x7ff;
    const rawB = raw & 0x7ff;
    const nextStrengthA = Math.round((rawA * 200) / 2047);
    const nextStrengthB = Math.round((rawB * 200) / 2047);

    if (this.shouldIgnoreStaleStopStrengthNotification(nextStrengthA, nextStrengthB)) {
      return;
    }

    this.state.strengthA = nextStrengthA;
    this.state.strengthB = nextStrengthB;
    this.emit();
  };
}
