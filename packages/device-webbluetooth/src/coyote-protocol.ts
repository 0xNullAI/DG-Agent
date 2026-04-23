import {
  createEmptyDeviceState,
  type Channel,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type WaveFrame,
} from '@dg-agent/core';
import {
  V2_BATTERY_CHAR,
  V2_BATTERY_SERVICE,
  V2_DEVICE_NAME_PREFIX,
  V2_PRIMARY_SERVICE,
  V2_STRENGTH_CHAR,
  V2_WAVE_A_CHAR,
  V2_WAVE_B_CHAR,
  V3_BATTERY_CHAR,
  V3_BATTERY_SERVICE,
  V3_NOTIFY_CHAR,
  V3_PRIMARY_SERVICE,
  V3_WRITE_CHAR,
} from './constants.js';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTCharacteristicLike,
  BluetoothRemoteGATTServerLike,
} from './types.js';

type StateListener = (state: DeviceState) => void;

interface ChannelWaveState {
  waveformId?: string;
  frames: WaveFrame[] | null;
  index: number;
  loop: boolean;
  active: boolean;
}

type Quad = [number, number, number, number];

const INACTIVE_FREQ: Quad = [0, 0, 0, 0];
const INACTIVE_INT: Quad = [0, 0, 0, 101];

export interface WebBluetoothAvailability {
  supported: boolean;
  reason?: string;
}

export interface WebBluetoothConnectionContext {
  device: BluetoothDeviceLike;
  server: BluetoothRemoteGATTServerLike;
}

export interface WebBluetoothProtocolAdapter {
  onConnected(context: WebBluetoothConnectionContext): Promise<void>;
  onDisconnected(): Promise<void>;
  getState(): DeviceState;
  execute(command: DeviceCommand): Promise<DeviceCommandResult>;
  emergencyStop(): Promise<void>;
  subscribe(listener: StateListener): () => void;
}

export class CoyoteProtocolAdapter implements WebBluetoothProtocolAdapter {
  private readonly listeners = new Set<StateListener>();
  private readonly waveState: Record<Channel, ChannelWaveState> = {
    A: { frames: null, index: 0, loop: false, active: false },
    B: { frames: null, index: 0, loop: false, active: false },
  };
  private readonly burstRestores = new Map<Channel, ReturnType<typeof setTimeout>>();

  private state: DeviceState = createEmptyDeviceState();
  private deviceVersion: 2 | 3 = 3;
  private writeChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private notifyChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private v2StrengthChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private v2WaveAChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private v2WaveBChar: BluetoothRemoteGATTCharacteristicLike | null = null;
  private tickWorker: Worker | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;
  private tickPaused = false;
  private suppressStaleStopStrengthNotifications = false;

  private seq = 0;
  private pendingMode = 0;
  private pendingStrA = 0;
  private pendingStrB = 0;
  private awaitingAck = false;

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async onConnected(context: WebBluetoothConnectionContext): Promise<void> {
    await this.onDisconnected();

    const name = context.device.name ?? '';
    this.deviceVersion = name.startsWith(V2_DEVICE_NAME_PREFIX) ? 2 : 3;
    this.state = {
      ...createEmptyDeviceState(),
      connected: true,
      deviceName: name,
      address: context.device.id ?? '',
      limitA: 200,
      limitB: 200,
    };

    if (this.deviceVersion === 3) {
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
    } else {
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
    }

    this.resetProtocolState();

    if (this.deviceVersion === 3) {
      await this.writeBF(this.state.limitA, this.state.limitB);
      this.pendingMode = (3 << 2) | 3;
      this.pendingStrA = 0;
      this.pendingStrB = 0;
    } else if (this.v2StrengthChar) {
      await this.v2StrengthChar.writeValueWithoutResponse(this.encodeV2Strength(0, 0));
    }

    this.startTickLoop();
    this.emit();
  }

  async onDisconnected(): Promise<void> {
    this.tickPaused = false;
    this.suppressStaleStopStrengthNotifications = false;
    this.stopTickLoop();
    this.cancelBurstRestore('A');
    this.cancelBurstRestore('B');

    if (this.notifyChar) {
      this.notifyChar.removeEventListener('characteristicvaluechanged', this.handleV3Notification);
      try {
        await this.notifyChar.stopNotifications();
      } catch {
        // ignore
      }
    }

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

    this.writeChar = null;
    this.notifyChar = null;
    this.batteryChar = null;
    this.v2StrengthChar = null;
    this.v2WaveAChar = null;
    this.v2WaveBChar = null;
    this.resetProtocolState();
    this.state = {
      ...createEmptyDeviceState(),
      deviceName: this.state.deviceName,
      address: this.state.address,
    };
    this.emit();
  }

  getState(): DeviceState {
    return {
      ...this.state,
      waveActiveA: this.waveState.A.active,
      waveActiveB: this.waveState.B.active,
      currentWaveA: this.waveState.A.waveformId,
      currentWaveB: this.waveState.B.waveformId,
    };
  }

  async execute(command: DeviceCommand): Promise<DeviceCommandResult> {
    if (!this.state.connected) {
      throw new Error('设备未连接');
    }

    if (command.type !== 'emergencyStop') {
      this.suppressStaleStopStrengthNotifications = false;
    }

    switch (command.type) {
      case 'start':
        this.setAbsoluteStrength(command.channel, command.strength);
        this.setWave(command.channel, command.waveform.id, command.waveform.frames, command.loop);
        break;
      case 'stop':
        if (command.channel) {
          this.setAbsoluteStrength(command.channel, 0);
          this.clearWave(command.channel);
        } else {
          this.setAbsoluteStrength('A', 0);
          this.setAbsoluteStrength('B', 0);
          this.clearWave('A');
          this.clearWave('B');
        }
        break;
      case 'adjustStrength':
        this.adjustStrength(command.channel, command.delta);
        break;
      case 'changeWave':
        this.setWave(command.channel, command.waveform.id, command.waveform.frames, command.loop);
        break;
      case 'burst':
        this.runBurst(command.channel, command.strength, command.durationMs);
        break;
      case 'emergencyStop':
        await this.emergencyStop();
        break;
    }

    this.emit();
    return { state: this.getState() };
  }

  async emergencyStop(): Promise<void> {
    this.tickPaused = true;
    this.suppressStaleStopStrengthNotifications = true;
    this.stopTickLoop();
    await this.waitForTickIdle();

    this.cancelBurstRestore('A');
    this.cancelBurstRestore('B');
    this.clearWave('A');
    this.clearWave('B');
    this.state.strengthA = 0;
    this.state.strengthB = 0;
    this.pendingStrA = 0;
    this.pendingStrB = 0;
    this.awaitingAck = false;
    this.seq = 0;
    this.pendingMode = 0;

    if (this.deviceVersion === 3 && this.writeChar) {
      try {
        await this.writeChar.writeValueWithoutResponse(
          this.buildImmediateAbsoluteStrengthPacket(0, 0),
        );
      } catch {
        // ignore best effort
      }
    } else if (this.deviceVersion === 2 && this.v2StrengthChar) {
      try {
        await this.v2StrengthChar.writeValueWithoutResponse(this.encodeV2Strength(0, 0));
      } catch {
        // ignore best effort
      }
    }

    this.emit();

    this.tickPaused = false;
    if (this.state.connected) {
      this.startTickLoop();
    }
  }

  private resetProtocolState(): void {
    this.seq = 0;
    this.pendingMode = 0;
    this.pendingStrA = 0;
    this.pendingStrB = 0;
    this.awaitingAck = false;
    this.waveState.A = { frames: null, index: 0, loop: false, active: false };
    this.waveState.B = { frames: null, index: 0, loop: false, active: false };
  }

  private setAbsoluteStrength(channel: Channel, value: number): void {
    const next = this.clamp(value, 0, 200);

    if (channel === 'A') {
      this.pendingStrA = next;
      this.state.strengthA = next;
      if (this.deviceVersion === 3) {
        this.pendingMode = (this.pendingMode & 0x03) | (3 << 2);
      }
    } else {
      this.pendingStrB = next;
      this.state.strengthB = next;
      if (this.deviceVersion === 3) {
        this.pendingMode = (this.pendingMode & 0x0c) | 3;
      }
    }
  }

  private adjustStrength(channel: Channel, delta: number): void {
    const next =
      channel === 'A'
        ? this.clamp(this.state.strengthA + this.toInt(delta), 0, 200)
        : this.clamp(this.state.strengthB + this.toInt(delta), 0, 200);

    const signedDelta = this.toInt(delta, 0);
    if (this.deviceVersion === 2) {
      this.setAbsoluteStrength(channel, next);
      return;
    }

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

  private setWave(channel: Channel, waveformId: string, frames: WaveFrame[], loop: boolean): void {
    this.waveState[channel] = {
      waveformId,
      frames: frames.map((frame): WaveFrame => [frame[0], frame[1]]),
      index: 0,
      loop,
      active: true,
    };
  }

  private clearWave(channel: Channel): void {
    this.waveState[channel] = {
      waveformId: undefined,
      frames: null,
      index: 0,
      loop: false,
      active: false,
    };
  }

  private runBurst(channel: Channel, strength: number, durationMs: number): void {
    this.cancelBurstRestore(channel);
    const previous = channel === 'A' ? this.state.strengthA : this.state.strengthB;
    this.setAbsoluteStrength(channel, strength);

    const timer = setTimeout(
      () => {
        const current = channel === 'A' ? this.state.strengthA : this.state.strengthB;
        const target = Math.min(current, previous);
        this.setAbsoluteStrength(channel, target);
        this.burstRestores.delete(channel);
        this.emit();
      },
      Math.max(100, durationMs),
    );

    this.burstRestores.set(channel, timer);
  }

  private cancelBurstRestore(channel: Channel): void {
    const timer = this.burstRestores.get(channel);
    if (timer) {
      clearTimeout(timer);
      this.burstRestores.delete(channel);
    }
  }

  private async onTick(): Promise<void> {
    if (this.tickPaused || this.tickInFlight || !this.state.connected) {
      return;
    }

    this.tickInFlight = true;
    try {
      if (this.tickPaused || !this.state.connected) {
        return;
      }

      if (this.deviceVersion === 3) {
        if (this.writeChar) {
          await this.writeChar.writeValueWithoutResponse(this.buildB0());
        }
      } else {
        await this.v2Tick();
      }
      if (!this.tickPaused) {
        this.emit();
      }
    } catch {
      // GATT disconnected mid-tick — suppress and let disconnect handler clean up
    } finally {
      this.tickInFlight = false;
    }
  }

  private async waitForTickIdle(): Promise<void> {
    while (this.tickInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async v2Tick(): Promise<void> {
    if (!this.v2StrengthChar) return;

    const strengthA = Math.min(this.pendingStrA, this.state.limitA);
    const strengthB = Math.min(this.pendingStrB, this.state.limitB);

    await this.v2StrengthChar.writeValueWithoutResponse(
      this.encodeV2Strength(strengthA, strengthB),
    );
    this.state.strengthA = strengthA;
    this.state.strengthB = strengthB;

    if (this.v2WaveAChar) {
      const next = this.advanceWave('A');
      if (next.int[3] >= 101) {
        await this.v2WaveAChar.writeValueWithoutResponse(this.encodeV2Wave(0, 0, 0));
      } else {
        const params = this.waveFrameToV2(next.freq[0] ?? 0, next.int[0] ?? 0);
        await this.v2WaveAChar.writeValueWithoutResponse(
          this.encodeV2Wave(params.x, params.y, params.z),
        );
      }
    }

    if (this.v2WaveBChar) {
      const next = this.advanceWave('B');
      if (next.int[3] >= 101) {
        await this.v2WaveBChar.writeValueWithoutResponse(this.encodeV2Wave(0, 0, 0));
      } else {
        const params = this.waveFrameToV2(next.freq[0] ?? 0, next.int[0] ?? 0);
        await this.v2WaveBChar.writeValueWithoutResponse(
          this.encodeV2Wave(params.x, params.y, params.z),
        );
      }
    }
  }

  private advanceWave(channel: Channel): { freq: Quad; int: Quad } {
    const current = this.waveState[channel];
    if (!current.active || !current.frames || current.frames.length === 0) {
      return { freq: [...INACTIVE_FREQ] as Quad, int: [...INACTIVE_INT] as Quad };
    }

    const length = current.frames.length;
    if (current.index >= length) {
      if (current.loop) {
        current.index = 0;
      } else {
        current.active = false;
        return { freq: [...INACTIVE_FREQ] as Quad, int: [...INACTIVE_INT] as Quad };
      }
    }

    const frame = current.frames[current.index];
    if (!frame) {
      current.active = false;
      return { freq: [...INACTIVE_FREQ] as Quad, int: [...INACTIVE_INT] as Quad };
    }

    current.index += 1;
    if (current.index >= length && !current.loop) {
      current.active = false;
    }

    const [rawFreq, rawInt] = frame;
    const frequency = this.clamp(rawFreq, 10, 240);
    const intensity = this.clamp(rawInt, 0, 100);
    return {
      freq: [frequency, frequency, frequency, frequency],
      int: [intensity, intensity, intensity, intensity],
    };
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

    const channelA = this.advanceWave('A');
    const channelB = this.advanceWave('B');

    buffer.set(channelA.freq, 4);
    buffer.set(channelA.int, 8);
    buffer.set(channelB.freq, 12);
    buffer.set(channelB.int, 16);

    return buffer;
  }

  private buildImmediateAbsoluteStrengthPacket(strengthA: number, strengthB: number): Uint8Array {
    const buffer = new Uint8Array(20);
    buffer[0] = 0xb0;
    buffer[1] = 0x33;
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
    await this.writeChar.writeValueWithoutResponse(this.buildBF(limitA, limitB));
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

  private nextSeq(): number {
    return this.seq >= 15 ? 1 : this.seq + 1;
  }

  private clamp(value: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  private toInt(value: unknown, fallback = 0): number {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
  }

  private async readBattery(): Promise<void> {
    if (!this.batteryChar) return;
    try {
      const value = await this.batteryChar.readValue();
      this.state.battery = value.getUint8(0);
      this.emit();
    } catch {
      this.state.battery = 0;
    }
  }

  private startTickLoop(): void {
    if (this.tickWorker || this.tickInterval) {
      return;
    }

    try {
      this.tickWorker = this.createTickWorker();
      this.tickWorker.onmessage = () => {
        void this.onTick();
      };
      this.tickWorker.postMessage('start');
    } catch {
      this.tickInterval = setInterval(() => {
        void this.onTick();
      }, 100);
    }
  }

  private stopTickLoop(): void {
    if (this.tickWorker) {
      this.tickWorker.postMessage('stop');
      this.tickWorker.terminate();
      this.tickWorker = null;
    }

    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private createTickWorker(): Worker {
    const code =
      'let timer;onmessage=(event)=>{if(event.data==="start"){if(timer)return;timer=setInterval(()=>postMessage(1),100);}else{clearInterval(timer);timer=null;}};';
    const blob = new Blob([code], { type: 'application/javascript' });
    return new Worker(URL.createObjectURL(blob));
  }

  private readonly handleV3Notification = (event: Event): void => {
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

  private readonly handleV2StrengthNotification = (event: Event): void => {
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

  private shouldIgnoreStaleStopStrengthNotification(strengthA: number, strengthB: number): boolean {
    return this.suppressStaleStopStrengthNotifications && (strengthA !== 0 || strengthB !== 0);
  }

  private emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
