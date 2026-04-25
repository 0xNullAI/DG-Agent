import {
  createEmptyDeviceState,
  type Channel,
  type DeviceCommand,
  type DeviceCommandResult,
  type DeviceState,
  type WaveFrame,
} from '@dg-agent/core';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTCharacteristicLike,
  BluetoothRemoteGATTServerLike,
} from './types.js';

export type StateListener = (state: DeviceState) => void;

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

export interface ChannelWaveState {
  waveformId?: string;
  frames: WaveFrame[] | null;
  index: number;
  loop: boolean;
  active: boolean;
}

export type Quad = [number, number, number, number];
export type WaveStep = { freq: number; int: number };

export const INACTIVE_FREQ: Quad = [0, 0, 0, 0];
export const INACTIVE_INT: Quad = [0, 0, 0, 101];
export const SILENT_WAVE_STEP: WaveStep = { freq: 10, int: 0 };

export abstract class BaseCoyoteProtocolAdapter implements WebBluetoothProtocolAdapter {
  private readonly listeners = new Set<StateListener>();
  protected readonly waveState: Record<Channel, ChannelWaveState> = {
    A: { frames: null, index: 0, loop: false, active: false },
    B: { frames: null, index: 0, loop: false, active: false },
  };
  protected readonly burstRestores = new Map<Channel, ReturnType<typeof setTimeout>>();

  protected state: DeviceState = createEmptyDeviceState();
  protected batteryChar: BluetoothRemoteGATTCharacteristicLike | null = null;

  private tickWorker: Worker | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private tickInFlight = false;

  protected tickPaused = false;
  protected suppressStaleStopStrengthNotifications = false;

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async onDisconnected(): Promise<void> {
    await this.resetConnectionState({ emit: true });
  }

  protected async resetConnectionState(options: { emit: boolean }): Promise<void> {
    this.tickPaused = false;
    this.suppressStaleStopStrengthNotifications = false;
    this.stopTickLoop();
    this.cancelBurstRestore('A');
    this.cancelBurstRestore('B');

    await this.disconnectProtocol();

    const previousDeviceName = this.state.deviceName;
    const previousAddress = this.state.address;
    this.batteryChar = null;
    this.resetProtocolState();
    this.state = {
      ...createEmptyDeviceState(),
      deviceName: previousDeviceName,
      address: previousAddress,
    };
    if (options.emit) {
      this.emit();
    }
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
    this.resetEmergencyStopState();

    await this.writeEmergencyStopPacket();
    this.emit();

    this.tickPaused = false;
    if (this.state.connected) {
      this.startTickLoop();
    }
  }

  protected setConnectedDevice(device: BluetoothDeviceLike): void {
    this.state = {
      ...createEmptyDeviceState(),
      connected: true,
      deviceName: device.name ?? '',
      address: device.id ?? '',
      limitA: 200,
      limitB: 200,
    };
  }

  protected startProtocolLoop(): void {
    this.startTickLoop();
    this.emit();
  }

  protected resetWaveState(): void {
    this.waveState.A = { frames: null, index: 0, loop: false, active: false };
    this.waveState.B = { frames: null, index: 0, loop: false, active: false };
  }

  protected setWave(
    channel: Channel,
    waveformId: string,
    frames: WaveFrame[],
    loop: boolean,
  ): void {
    this.waveState[channel] = {
      waveformId,
      frames: frames.map((frame): WaveFrame => [frame[0], frame[1]]),
      index: 0,
      loop,
      active: true,
    };
  }

  protected clearWave(channel: Channel): void {
    this.waveState[channel] = {
      waveformId: undefined,
      frames: null,
      index: 0,
      loop: false,
      active: false,
    };
  }

  protected runBurst(channel: Channel, strength: number, durationMs: number): void {
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

  protected cancelBurstRestore(channel: Channel): void {
    const timer = this.burstRestores.get(channel);
    if (timer) {
      clearTimeout(timer);
      this.burstRestores.delete(channel);
    }
  }

  protected async onTick(): Promise<void> {
    if (this.tickPaused || this.tickInFlight || !this.state.connected) {
      return;
    }

    this.tickInFlight = true;
    try {
      if (this.tickPaused || !this.state.connected) {
        return;
      }

      await this.performTick();
      if (!this.tickPaused) {
        this.emit();
      }
    } catch {
      // GATT disconnected mid-tick; suppress and let disconnect handler clean up.
    } finally {
      this.tickInFlight = false;
    }
  }

  protected async waitForTickIdle(): Promise<void> {
    while (this.tickInFlight) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  protected advanceWaveStep(channel: Channel): WaveStep | null {
    const current = this.waveState[channel];
    if (!current.active || !current.frames || current.frames.length === 0) {
      return null;
    }

    const length = current.frames.length;
    if (current.index >= length) {
      if (current.loop) {
        current.index = 0;
      } else {
        current.active = false;
        return null;
      }
    }

    const frame = current.frames[current.index];
    if (!frame) {
      current.active = false;
      return null;
    }

    current.index += 1;
    if (current.index >= length && !current.loop) {
      current.active = false;
    }

    const [rawFreq, rawInt] = frame;
    return {
      freq: this.clamp(rawFreq, SILENT_WAVE_STEP.freq, 240),
      int: this.clamp(rawInt, 0, 100),
    };
  }

  protected advanceWavePacket(channel: Channel): { freq: Quad; int: Quad } {
    const first = this.advanceWaveStep(channel);
    if (!first) {
      return { freq: [...INACTIVE_FREQ] as Quad, int: [...INACTIVE_INT] as Quad };
    }

    const freq = [first.freq, SILENT_WAVE_STEP.freq, SILENT_WAVE_STEP.freq, SILENT_WAVE_STEP.freq];
    const int = [first.int, SILENT_WAVE_STEP.int, SILENT_WAVE_STEP.int, SILENT_WAVE_STEP.int];

    for (let index = 1; index < 4; index++) {
      const next = this.advanceWaveStep(channel);
      if (!next) break;
      freq[index] = next.freq;
      int[index] = next.int;
    }

    return {
      freq: freq as Quad,
      int: int as Quad,
    };
  }

  protected clamp(value: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, Math.round(number)));
  }

  protected toInt(value: unknown, fallback = 0): number {
    const number = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(number) ? Math.round(number) : fallback;
  }

  protected async readBattery(): Promise<void> {
    if (!this.batteryChar) return;
    try {
      const value = await this.batteryChar.readValue();
      this.state.battery = value.getUint8(0);
      this.emit();
    } catch {
      this.state.battery = 0;
    }
  }

  protected shouldIgnoreStaleStopStrengthNotification(
    strengthA: number,
    strengthB: number,
  ): boolean {
    return this.suppressStaleStopStrengthNotifications && (strengthA !== 0 || strengthB !== 0);
  }

  protected async writeCharacteristicValue(
    characteristic: BluetoothRemoteGATTCharacteristicLike,
    value: ArrayBufferView | ArrayBuffer,
    options: { preferResponse?: boolean } = {},
  ): Promise<void> {
    const attempts = options.preferResponse
      ? [
          characteristic.writeValueWithResponse?.bind(characteristic),
          characteristic.writeValueWithoutResponse?.bind(characteristic),
          characteristic.writeValue?.bind(characteristic),
        ]
      : [
          characteristic.writeValueWithoutResponse?.bind(characteristic),
          characteristic.writeValueWithResponse?.bind(characteristic),
          characteristic.writeValue?.bind(characteristic),
        ];

    let lastError: unknown = null;
    for (const attempt of attempts) {
      if (!attempt) continue;
      try {
        await attempt(value);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError ?? new Error('Bluetooth characteristic is not writable');
  }

  protected emit(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
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

  protected abstract disconnectProtocol(): Promise<void>;
  abstract onConnected(context: WebBluetoothConnectionContext): Promise<void>;
  protected abstract resetProtocolState(): void;
  protected abstract resetEmergencyStopState(): void;
  protected abstract setAbsoluteStrength(channel: Channel, value: number): void;
  protected abstract adjustStrength(channel: Channel, delta: number): void;
  protected abstract performTick(): Promise<void>;
  protected abstract writeEmergencyStopPacket(): Promise<void>;
}
