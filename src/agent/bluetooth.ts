/**
 * Web Bluetooth module for DG-Lab Coyote 3.0
 * Pure ES module implementing the full BLE protocol.
 */

import type { DeviceState, Channel, WavePreset, WaveFrame, WaveStep } from '../types';

// ---------------------------------------------------------------------------
// Minimal Web Bluetooth type declarations (not in standard DOM lib)
// ---------------------------------------------------------------------------
interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  value: DataView | null;
  writeValueWithoutResponse(value: ArrayBufferView | ArrayBuffer): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTServer {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothDevice extends EventTarget {
  id: string;
  name: string | undefined;
  gatt: BluetoothRemoteGATTServer;
}

// ---------------------------------------------------------------------------
// BLE UUIDs
// ---------------------------------------------------------------------------
const DEVICE_NAME_PREFIX = '47L121';
const PRIMARY_SERVICE    = '0000180c-0000-1000-8000-00805f9b34fb';
const WRITE_CHAR         = '0000150a-0000-1000-8000-00805f9b34fb';
const NOTIFY_CHAR        = '0000150b-0000-1000-8000-00805f9b34fb';
const BATTERY_SERVICE    = '0000180a-0000-1000-8000-00805f9b34fb';
const BATTERY_CHAR       = '00001500-0000-1000-8000-00805f9b34fb';

// ---------------------------------------------------------------------------
// Preset waveforms  –  each entry is [encoded_freq, intensity]
// ---------------------------------------------------------------------------
const PRESETS: Record<WavePreset, WaveFrame[]> = {
  breath: [
    [10,0],[10,20],[10,40],[10,60],[10,80],[10,100],
    [10,100],[10,100],[10,0],[10,0],[10,0],[10,0],
  ],
  tide: [
    [10,0],[11,16],[13,33],[14,50],[16,66],[18,83],[19,100],
    [21,92],[22,84],[24,76],[26,68],[26,0],[27,16],[29,33],
    [30,50],[32,66],[34,83],[35,100],[37,92],[38,84],[40,76],[42,68],
  ],
  pulse_low:  Array.from({ length: 10 }, (): WaveFrame => [10, 30]),
  pulse_mid:  Array.from({ length: 10 }, (): WaveFrame => [10, 60]),
  pulse_high: Array.from({ length: 10 }, (): WaveFrame => [10, 100]),
  tap: [
    [10,100],[10,0],[10,0],[10,100],[10,0],[10,0],
  ],
};

// ---------------------------------------------------------------------------
// Frequency encoding helper
// ---------------------------------------------------------------------------
function encodeFrequency(freqMs: number): number {
  const f = Number(freqMs);
  if (!Number.isFinite(f) || f < 10 || f > 1000) return 10;
  if (f <= 100) return Math.floor(f);
  if (f <= 600) return Math.floor((f - 100) / 5) + 100;
  return Math.floor((f - 600) / 10) + 200;
}

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------
export const state: DeviceState = {
  connected: false,
  deviceName: '',
  address: '',
  battery: 0,
  strengthA: 0,
  strengthB: 0,
  limitA: 200,
  limitB: 200,
  waveActiveA: false,
  waveActiveB: false,
};

/** External callback – invoked whenever state changes. */
let onStatusChange: ((status: DeviceState) => void) | null = null;

// Provide a setter so external code can assign the callback.
// (Reassigning a `let` export from outside the module is not allowed by spec,
//  so callers should use this helper or import the module object.)
export function setOnStatusChange(fn: ((status: DeviceState) => void) | null): void {
  onStatusChange = fn;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
let bleDevice: BluetoothDevice | null = null;
let bleServer: BluetoothRemoteGATTServer | null = null;
let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;
let batteryChar: BluetoothRemoteGATTCharacteristic | null = null;

let b0Interval: ReturnType<typeof setInterval> | null = null;

// Seq / ack bookkeeping
let seq = 0;           // 0 = idle (no pending strength change)
let pendingMode = 0;   // 4-bit strength mode nibble for next B0
let pendingStrA = 0;   // strength value to send when mode != 0
let pendingStrB = 0;
let awaitingAck = false;

// Waveform playback state per channel
interface ChannelWaveState {
  frames: WaveFrame[] | null;
  index: number;
  loop: boolean;
  active: boolean;
}

const waveState: Record<Channel, ChannelWaveState> = {
  A: { frames: null, index: 0, loop: false, active: false },
  B: { frames: null, index: 0, loop: false, active: false },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function notify(): void {
  state.waveActiveA = waveState.A.active;
  state.waveActiveB = waveState.B.active;
  if (typeof onStatusChange === 'function') {
    try { onStatusChange(getStatus()); } catch (_e) { /* swallow */ }
  }
}

function nextSeq(): number {
  seq = seq >= 15 ? 1 : seq + 1;
  return seq;
}

function clamp(v: number, lo: number, hi: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/** Coerce arbitrary input to a finite integer; non-numeric → fallback. */
function toInt(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

// Inactive channel marker: freq=[0,0,0,0], int=[0,0,101,101] – spec says
// intensity[3] >= 101 marks inactive.  We use the exact pattern from the spec:
// freq = [0,0,0,0], intensity = [0,0,0,101].
const INACTIVE_FREQ: number[] = [0, 0, 0, 0];
const INACTIVE_INT: number[]  = [0, 0, 0, 101];

// ---------------------------------------------------------------------------
// Wave frame helpers
// ---------------------------------------------------------------------------

/**
 * Advance a channel's waveform by one frame and return {freq[4], int[4]}.
 * Each preset entry = 100ms = one B0 tick.  The B0 packet has 4 sub-frames
 * per channel (25ms each), so we fill all 4 sub-frames with the same value
 * from the current frame, then advance the frame index by 1.
 */
function advanceWave(ch: Channel): { freq: number[]; int: number[] } {
  const ws = waveState[ch];
  if (!ws.active || !ws.frames || ws.frames.length === 0) {
    return { freq: INACTIVE_FREQ, int: INACTIVE_INT };
  }

  const len = ws.frames.length;

  if (ws.index >= len) {
    if (ws.loop) {
      ws.index = 0;
    } else {
      ws.active = false;
      return { freq: INACTIVE_FREQ, int: INACTIVE_INT };
    }
  }

  const [f, i] = ws.frames[ws.index];
  ws.index++;

  // Check if waveform just ended
  if (ws.index >= len && !ws.loop) {
    ws.active = false;
  }

  // Fill all 4 sub-frames with the same value
  return { freq: [f, f, f, f], int: [i, i, i, i] };
}

// ---------------------------------------------------------------------------
// B0 command builder
// ---------------------------------------------------------------------------
function buildB0(): Uint8Array {
  const buf = new Uint8Array(20);
  buf[0] = 0xB0;

  // Determine strength mode nibble
  let modeNibble = 0;
  let strA = 0;
  let strB = 0;

  if (!awaitingAck && pendingMode !== 0) {
    // We have a pending strength change – stamp it with the next seq.
    nextSeq();
    modeNibble = pendingMode;
    strA = pendingStrA;
    strB = pendingStrB;
    awaitingAck = true;
    pendingMode = 0;
  } else {
    // Either waiting for ack or nothing pending – send mode=0 (no change).
    modeNibble = 0;
    strA = pendingStrA;
    strB = pendingStrB;
  }

  buf[1] = ((seq & 0x0F) << 4) | (modeNibble & 0x0F);
  buf[2] = clamp(strA, 0, 200);
  buf[3] = clamp(strB, 0, 200);

  // Channel A wave
  const wA = advanceWave('A');
  buf[4]  = wA.freq[0]; buf[5]  = wA.freq[1]; buf[6]  = wA.freq[2]; buf[7]  = wA.freq[3];
  buf[8]  = wA.int[0];  buf[9]  = wA.int[1];  buf[10] = wA.int[2];  buf[11] = wA.int[3];

  // Channel B wave
  const wB = advanceWave('B');
  buf[12] = wB.freq[0]; buf[13] = wB.freq[1]; buf[14] = wB.freq[2]; buf[15] = wB.freq[3];
  buf[16] = wB.int[0];  buf[17] = wB.int[1];  buf[18] = wB.int[2];  buf[19] = wB.int[3];

  return buf;
}

// ---------------------------------------------------------------------------
// B1 notification handler
// ---------------------------------------------------------------------------
function handleNotification(event: Event): void {
  const target = event.target as BluetoothRemoteGATTCharacteristic;
  const dv = target.value; // DataView
  if (!dv || dv.byteLength < 4) return;

  const header = dv.getUint8(0);
  if (header !== 0xB1) return;

  const ackSeq = dv.getUint8(1);
  const curA   = dv.getUint8(2);
  const curB   = dv.getUint8(3);

  // Update confirmed strength values
  state.strengthA = curA;
  state.strengthB = curB;

  // If the echoed seq matches our pending seq, clear the ack gate.
  if (ackSeq === seq && awaitingAck) {
    awaitingAck = false;
    seq = 0; // back to idle
  }

  notify();
}

// ---------------------------------------------------------------------------
// BF command (set limits / balance)
// ---------------------------------------------------------------------------
function buildBF(limitA: number, limitB: number, bfA = 160, bfB = 160, biA = 0, biB = 0): Uint8Array {
  const buf = new Uint8Array(7);
  buf[0] = 0xBF;
  buf[1] = clamp(limitA, 0, 200);
  buf[2] = clamp(limitB, 0, 200);
  buf[3] = bfA & 0xFF;
  buf[4] = bfB & 0xFF;
  buf[5] = biA & 0xFF;
  buf[6] = biB & 0xFF;
  return buf;
}

async function writeBF(limitA: number, limitB: number): Promise<void> {
  if (!writeChar) return;
  const cmd = buildBF(limitA, limitB);
  await writeChar.writeValueWithoutResponse(cmd);
}

// ---------------------------------------------------------------------------
// 100 ms B0 loop
// ---------------------------------------------------------------------------
function startB0Loop(): void {
  if (b0Interval) return;
  b0Interval = setInterval(async () => {
    if (!writeChar) return;
    try {
      const cmd = buildB0();
      await writeChar.writeValueWithoutResponse(cmd);
      notify();
    } catch (err) {
      console.error('[bluetooth] B0 write error:', err);
    }
  }, 100);
}

function stopB0Loop(): void {
  if (b0Interval) {
    clearInterval(b0Interval);
    b0Interval = null;
  }
}

// ---------------------------------------------------------------------------
// Battery reading
// ---------------------------------------------------------------------------
async function readBattery(): Promise<void> {
  if (!batteryChar) return;
  try {
    const dv = await batteryChar.readValue();
    state.battery = dv.getUint8(0);
    notify();
  } catch (err) {
    console.warn('[bluetooth] battery read error:', err);
  }
}

// ---------------------------------------------------------------------------
// Disconnect handler
// ---------------------------------------------------------------------------
function onDisconnected(): void {
  stopB0Loop();
  writeChar = null;
  notifyChar = null;
  batteryChar = null;
  bleServer = null;
  state.connected = false;
  awaitingAck = false;
  seq = 0;
  pendingMode = 0;
  waveState.A.active = false;
  waveState.B.active = false;
  notify();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan for a Coyote 3.0 device and connect.
 * Starts the 100 ms B0 command loop upon successful connection.
 */
export async function scanAndConnect(): Promise<void> {
  if (state.connected) {
    throw new Error('Already connected');
  }

  const bt = (navigator as any).bluetooth as any;
  const device: BluetoothDevice = await bt.requestDevice({
    filters: [{ namePrefix: DEVICE_NAME_PREFIX }],
    optionalServices: [PRIMARY_SERVICE, BATTERY_SERVICE],
  });

  bleDevice = device;
  state.deviceName = device.name || '';
  state.address = device.id || '';
  device.addEventListener('gattserverdisconnected', onDisconnected);

  bleServer = await device.gatt.connect();

  // Primary service – write & notify characteristics
  const primarySvc = await bleServer.getPrimaryService(PRIMARY_SERVICE);
  writeChar  = await primarySvc.getCharacteristic(WRITE_CHAR);
  notifyChar = await primarySvc.getCharacteristic(NOTIFY_CHAR);

  // Subscribe to B1 notifications
  await notifyChar.startNotifications();
  notifyChar.addEventListener('characteristicvaluechanged', handleNotification);

  // Battery service
  try {
    const batSvc = await bleServer.getPrimaryService(BATTERY_SERVICE);
    batteryChar = await batSvc.getCharacteristic(BATTERY_CHAR);
    await readBattery();
  } catch (_e) {
    console.warn('[bluetooth] battery service unavailable');
  }

  // Reset internal state
  seq = 0;
  awaitingAck = false;
  pendingMode = 0;
  pendingStrA = 0;
  pendingStrB = 0;
  waveState.A.active = false;
  waveState.B.active = false;

  state.connected = true;
  state.strengthA = 0;
  state.strengthB = 0;

  // Send default limits via BF
  await writeBF(state.limitA, state.limitB);

  // Start the continuous B0 loop
  startB0Loop();

  notify();
}

/**
 * Disconnect from the device and stop all loops.
 */
export async function disconnect(): Promise<void> {
  stopB0Loop();
  if (notifyChar) {
    try {
      notifyChar.removeEventListener('characteristicvaluechanged', handleNotification);
      await notifyChar.stopNotifications();
    } catch (_e) { /* ignore */ }
  }
  if (bleDevice && bleDevice.gatt.connected) {
    bleDevice.gatt.disconnect();
  }
  onDisconnected();
}

/**
 * Set absolute strength for a channel.
 * @param channel  'A' or 'B'
 * @param value  0-200
 */
export function setStrength(channel: string, value: number): void {
  if (!writeChar) throw new Error('设备未连接');
  const ch = String(channel || '').toUpperCase() as Channel;
  if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);
  const v = clamp(toInt(value, 0), 0, 200);
  if (ch === 'A') {
    pendingStrA = v;
    // mode bits 3-2 = channel A, set to 3 (absolute)
    pendingMode = (pendingMode & 0x03) | (3 << 2);
  } else {
    pendingStrB = v;
    // mode bits 1-0 = channel B, set to 3 (absolute)
    pendingMode = (pendingMode & 0x0C) | 3;
  }
}

/**
 * Relative strength change for a channel.
 * @param channel  'A' or 'B'
 * @param delta  positive = increase, negative = decrease
 */
export function addStrength(channel: string, delta: number): void {
  if (!writeChar) throw new Error('设备未连接');
  const ch = String(channel || '').toUpperCase() as Channel;
  if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);
  const d = toInt(delta, 0);
  if (d === 0) return;

  const mode = d > 0 ? 1 : 2;
  const magnitude = clamp(Math.abs(d), 0, 200);

  if (ch === 'A') {
    pendingStrA = magnitude;
    pendingMode = (pendingMode & 0x03) | (mode << 2);
  } else {
    pendingStrB = magnitude;
    pendingMode = (pendingMode & 0x0C) | mode;
  }
}

/**
 * Set strength limits and send BF command.
 * @param limitA  0-200
 * @param limitB  0-200
 */
export function setStrengthLimit(limitA: number, limitB: number): void {
  if (!writeChar) throw new Error('设备未连接');
  state.limitA = clamp(toInt(limitA, 0), 0, 200);
  state.limitB = clamp(toInt(limitB, 0), 0, 200);
  writeBF(state.limitA, state.limitB).catch((err: unknown) => {
    console.error('[bluetooth] BF write error:', err);
  });
  notify();
}

/**
 * Play a preset waveform on a channel.
 * @param channel  'A' or 'B'
 * @param preset  One of: breath, tide, pulse_low, pulse_mid, pulse_high, tap
 * @param frequency  Override frequency in ms (applied to every frame)
 * @param intensity  Override intensity 0-100 (scales frame intensities)
 * @param durationFrames  Number of frames to play (0 or undefined = full preset)
 * @param loop  Whether to loop the waveform
 */
export function sendWave(
  channel: string,
  preset: string | null,
  frequency: number | null | undefined,
  intensity: number | null | undefined,
  durationFrames: number = 10,
  loop: boolean = false,
): void {
  if (!writeChar) throw new Error('设备未连接');
  const ch = String(channel || '').toUpperCase() as Channel;
  if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);

  const freqN = frequency == null ? null : toInt(frequency, 10);
  const intN = intensity == null ? null : clamp(toInt(intensity, 0), 0, 100);
  const framesN = Math.max(1, toInt(durationFrames, 10));
  let frames: WaveFrame[];

  if (preset && PRESETS[preset as WavePreset]) {
    // Use preset, optionally overriding frequency/intensity
    frames = PRESETS[preset as WavePreset].map(([f, i]): WaveFrame => {
      let ef = f;
      let ei = i;
      if (freqN !== null) ef = encodeFrequency(freqN);
      if (intN !== null) ei = Math.round((i * intN) / 100);
      return [ef, ei];
    });
  } else if (freqN !== null) {
    const ef = encodeFrequency(freqN);
    const ei = intN !== null ? intN : 50;
    frames = Array.from({ length: framesN }, (): WaveFrame => [ef, ei]);
  } else {
    throw new Error(`Must provide a valid preset or frequency. Got preset="${preset}"`);
  }

  const ws = waveState[ch];
  ws.frames = frames;
  ws.index = 0;
  ws.loop = loop;
  ws.active = true;
  notify();
}

/**
 * Design a custom waveform from step descriptors.
 * @param channel  'A' or 'B'
 * @param steps  Array of step descriptors
 * @param loop  Whether to loop
 */
export function designWave(channel: string, steps: WaveStep[], loop: boolean = false): void {
  if (!writeChar) throw new Error('设备未连接');
  const ch = String(channel || '').toUpperCase() as Channel;
  if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);
  if (!Array.isArray(steps)) throw new Error('designWave: steps must be an array');
  const frames: WaveFrame[] = [];
  for (const step of steps) {
    const ef = encodeFrequency(toInt((step as any)?.freq, 10));
    const ei = clamp(toInt((step as any)?.intensity, 0), 0, 100);
    const count = Math.max(1, toInt((step as any)?.repeat, 1));
    for (let r = 0; r < count; r++) {
      frames.push([ef, ei]);
    }
  }

  if (frames.length === 0) {
    throw new Error('designWave: no frames produced');
  }

  const ws = waveState[ch];
  ws.frames = frames;
  ws.index = 0;
  ws.loop = loop;
  ws.active = true;
  notify();
}

/**
 * Stop waveform playback on one or both channels.
 * @param channel  'A', 'B', or null/undefined for both
 */
export function stopWave(channel?: string | null): void {
  if (!writeChar) throw new Error('设备未连接');
  let channels: Channel[];
  if (channel) {
    const ch = String(channel).toUpperCase() as Channel;
    if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);
    channels = [ch];
  } else {
    channels = ['A', 'B'];
  }
  for (const ch of channels) {
    waveState[ch].active = false;
    waveState[ch].frames = null;
    waveState[ch].index = 0;
  }
  notify();
}

/**
 * Return a JSON-friendly snapshot of the current state.
 */
export function getStatus(): DeviceState {
  return {
    connected:   state.connected,
    deviceName:  state.deviceName,
    address:     state.address,
    battery:     state.battery,
    strengthA:   state.strengthA,
    strengthB:   state.strengthB,
    limitA:      state.limitA,
    limitB:      state.limitB,
    waveActiveA: waveState.A.active,
    waveActiveB: waveState.B.active,
  };
}

export function getStrengthLimits(): { limitA: number; limitB: number } {
  return { limitA: state.limitA, limitB: state.limitB };
}

/**
 * Emergency full stop: stop all waveforms and set both channels to zero.
 * Designed for page unload / background scenarios — fire-and-forget.
 */
export function emergencyStop(): void {
  // Stop waveforms
  waveState.A.active = false;
  waveState.A.frames = null;
  waveState.A.index = 0;
  waveState.B.active = false;
  waveState.B.frames = null;
  waveState.B.index = 0;

  // Set strength to zero (absolute mode = 3)
  pendingStrA = 0;
  pendingStrB = 0;
  pendingMode = (3 << 2) | 3; // absolute zero for both channels

  // Send one final B0 immediately if possible
  if (writeChar) {
    try {
      const cmd = buildB0();
      writeChar.writeValueWithoutResponse(cmd);
    } catch (_) { /* best effort */ }
  }

  notify();
}
