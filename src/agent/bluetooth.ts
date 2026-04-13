/**
 * Web Bluetooth module for DG-Lab Coyote 2.0 & 3.0
 * Pure ES module implementing the full BLE protocol for both hardware versions.
 */

import type { DeviceState, Channel, WaveFrame } from '../types';

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
// BLE UUIDs — Coyote 3.0
// ---------------------------------------------------------------------------
const V3_DEVICE_NAME_PREFIX = '47L121';
const V3_PRIMARY_SERVICE = '0000180c-0000-1000-8000-00805f9b34fb';
const V3_WRITE_CHAR = '0000150a-0000-1000-8000-00805f9b34fb';
const V3_NOTIFY_CHAR = '0000150b-0000-1000-8000-00805f9b34fb';
const V3_BATTERY_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const V3_BATTERY_CHAR = '00001500-0000-1000-8000-00805f9b34fb';

// ---------------------------------------------------------------------------
// BLE UUIDs — Coyote 2.0
// ---------------------------------------------------------------------------
const V2_DEVICE_NAME_PREFIX = 'D-LAB ESTIM';
const v2Uuid = (short: string) => `955a${short}-0fe2-f5aa-a094-84b8d4f3e8ad`;
const V2_PRIMARY_SERVICE = v2Uuid('180b');
const V2_STRENGTH_CHAR = v2Uuid('1504'); // PWM_AB2: strength for both channels
const V2_WAVE_A_CHAR = v2Uuid('1505'); // PWM_A34: channel A waveform params
const V2_WAVE_B_CHAR = v2Uuid('1506'); // PWM_B34: channel B waveform params
const V2_BATTERY_SERVICE = v2Uuid('180a');
const V2_BATTERY_CHAR = v2Uuid('1500');

// Frequency/strength encoding for waveforms is now handled upstream in the
// waveforms module, which parses user-imported pulse files and seeds the
// built-in defaults. This module only plays back ready-made WaveFrame[]s.

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
let batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
let tickWorker: Worker | null = null;
let tickInterval: ReturnType<typeof setInterval> | null = null;

// Device version detected on connect
let deviceVersion: 2 | 3 = 3;

// V3-specific characteristics
let writeChar: BluetoothRemoteGATTCharacteristic | null = null;
let notifyChar: BluetoothRemoteGATTCharacteristic | null = null;

// V2-specific characteristics
let v2StrengthChar: BluetoothRemoteGATTCharacteristic | null = null;
let v2WaveAChar: BluetoothRemoteGATTCharacteristic | null = null;
let v2WaveBChar: BluetoothRemoteGATTCharacteristic | null = null;

// Seq / ack bookkeeping
let seq = 0; // 0 = idle (no pending strength change)
let pendingMode = 0; // 4-bit strength mode nibble for next B0
let pendingStrA = 0; // strength value to send when mode != 0
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
    try {
      onStatusChange(getStatus());
    } catch (_e) {
      /* swallow */
    }
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

// V3 inactive channel marker: freq=[0,0,0,0], int=[0,0,0,101] – spec says
// intensity[3] >= 101 marks inactive.
const INACTIVE_FREQ: number[] = [0, 0, 0, 0];
const INACTIVE_INT: number[] = [0, 0, 0, 101];

// ---------------------------------------------------------------------------
// V2 encoding helpers
// ---------------------------------------------------------------------------

/** Decode a V3 encoded frequency byte (10-240) back to real period in ms. */
function decodeV3Freq(encoded: number): number {
  if (encoded <= 100) return encoded; // 10-100ms: direct
  if (encoded <= 200) return (encoded - 100) * 5 + 100; // 100-600ms
  return (encoded - 200) * 10 + 600; // 600-1000ms
}

/** Convert a V3 WaveFrame (encoded_freq, intensity) to V2 pulse parameters. */
function waveFrameToV2(freq: number, intensity: number): { x: number; y: number; z: number } {
  const periodMs = decodeV3Freq(freq);
  const x = 1; // 1 pulse per unit
  const y = clamp(periodMs - 1, 0, 1023); // interval to fill period
  const z = clamp(Math.round((intensity * 31) / 100), 0, 31); // pulse width
  return { x, y, z };
}

/** Encode V2 strength for both channels into 3 bytes (PWM_AB2). */
function encodeV2Strength(a: number, b: number): Uint8Array {
  // Map unified 0-200 range to V2 hardware range 0-2047
  const va = Math.round((clamp(a, 0, 200) * 2047) / 200);
  const vb = Math.round((clamp(b, 0, 200) * 2047) / 200);
  // 3 bytes = 24 bits: [1:0] reserved, [21:11] ch A, [10:0] ch B
  const val = (va << 11) | vb;
  return new Uint8Array([(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]);
}

/** Encode V2 waveform parameters into 3 bytes (PWM_A34 / PWM_B34). */
function encodeV2Wave(x: number, y: number, z: number): Uint8Array {
  // 3 bytes = 24 bits: [23:20] reserved, [19:15] Z, [14:5] Y, [4:0] X
  const val = ((z & 0x1f) << 15) | ((y & 0x3ff) << 5) | (x & 0x1f);
  return new Uint8Array([(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]);
}

/** V2 100ms tick: write strength + waveform to separate characteristics. */
async function v2Tick(): Promise<void> {
  if (!v2StrengthChar) return;

  // Enforce limits client-side (V2 has no BF command)
  const strA = Math.min(pendingStrA, state.limitA);
  const strB = Math.min(pendingStrB, state.limitB);

  await v2StrengthChar.writeValueWithoutResponse(encodeV2Strength(strA, strB));
  state.strengthA = strA;
  state.strengthB = strB;

  // Channel A waveform
  if (v2WaveAChar) {
    const wA = advanceWave('A');
    if (wA.int[3] >= 101) {
      // Inactive marker — send zeros to silence the channel
      await v2WaveAChar.writeValueWithoutResponse(encodeV2Wave(0, 0, 0));
    } else {
      const p = waveFrameToV2(wA.freq[0], wA.int[0]);
      await v2WaveAChar.writeValueWithoutResponse(encodeV2Wave(p.x, p.y, p.z));
    }
  }

  // Channel B waveform
  if (v2WaveBChar) {
    const wB = advanceWave('B');
    if (wB.int[3] >= 101) {
      await v2WaveBChar.writeValueWithoutResponse(encodeV2Wave(0, 0, 0));
    } else {
      const p = waveFrameToV2(wB.freq[0], wB.int[0]);
      await v2WaveBChar.writeValueWithoutResponse(encodeV2Wave(p.x, p.y, p.z));
    }
  }
}

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
  buf[0] = 0xb0;

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

  buf[1] = ((seq & 0x0f) << 4) | (modeNibble & 0x0f);
  buf[2] = clamp(strA, 0, 200);
  buf[3] = clamp(strB, 0, 200);

  // Channel A wave
  const wA = advanceWave('A');
  buf[4] = wA.freq[0];
  buf[5] = wA.freq[1];
  buf[6] = wA.freq[2];
  buf[7] = wA.freq[3];
  buf[8] = wA.int[0];
  buf[9] = wA.int[1];
  buf[10] = wA.int[2];
  buf[11] = wA.int[3];

  // Channel B wave
  const wB = advanceWave('B');
  buf[12] = wB.freq[0];
  buf[13] = wB.freq[1];
  buf[14] = wB.freq[2];
  buf[15] = wB.freq[3];
  buf[16] = wB.int[0];
  buf[17] = wB.int[1];
  buf[18] = wB.int[2];
  buf[19] = wB.int[3];

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
  if (header !== 0xb1) return;

  const ackSeq = dv.getUint8(1);
  const curA = dv.getUint8(2);
  const curB = dv.getUint8(3);

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
function buildBF(
  limitA: number,
  limitB: number,
  bfA = 160,
  bfB = 160,
  biA = 0,
  biB = 0,
): Uint8Array {
  const buf = new Uint8Array(7);
  buf[0] = 0xbf;
  buf[1] = clamp(limitA, 0, 200);
  buf[2] = clamp(limitB, 0, 200);
  buf[3] = bfA & 0xff;
  buf[4] = bfB & 0xff;
  buf[5] = biA & 0xff;
  buf[6] = biB & 0xff;
  return buf;
}

async function writeBF(limitA: number, limitB: number): Promise<void> {
  if (!writeChar) return;
  const cmd = buildBF(limitA, limitB);
  await writeChar.writeValueWithoutResponse(cmd);
}

// ---------------------------------------------------------------------------
// 100 ms tick loop (V3: B0 packet, V2: separate characteristic writes)
// ---------------------------------------------------------------------------
async function onTick(): Promise<void> {
  try {
    if (deviceVersion === 3) {
      if (!writeChar) return;
      const cmd = buildB0();
      await writeChar.writeValueWithoutResponse(cmd);
    } else {
      await v2Tick();
    }
    notify();
  } catch (err) {
    console.error('[bluetooth] tick error:', err);
  }
}

/**
 * Create a Web Worker from an inline blob so we don't need a separate file.
 * The worker simply runs setInterval and posts a message every 100ms.
 * Worker timers are NOT throttled when the page is hidden.
 */
function createTickWorker(): Worker {
  const code =
    'let t;onmessage=e=>{if(e.data==="start"){if(t)return;t=setInterval(()=>postMessage(1),100)}else{clearInterval(t);t=null}}';
  const blob = new Blob([code], { type: 'application/javascript' });
  return new Worker(URL.createObjectURL(blob));
}

function startTickLoop(): void {
  if (tickWorker || tickInterval) return;
  try {
    tickWorker = createTickWorker();
    tickWorker.onmessage = () => onTick();
    tickWorker.postMessage('start');
  } catch (_) {
    // Worker creation can fail (e.g. CSP restrictions) — fall back to setInterval
    console.warn('[bluetooth] Worker unavailable, falling back to setInterval');
    tickInterval = setInterval(() => onTick(), 100);
  }
}

function stopTickLoop(): void {
  if (tickWorker) {
    tickWorker.postMessage('stop');
    tickWorker.terminate();
    tickWorker = null;
  }
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
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
  stopTickLoop();
  // V3 chars
  writeChar = null;
  notifyChar = null;
  // V2 chars
  v2StrengthChar = null;
  v2WaveAChar = null;
  v2WaveBChar = null;
  // Common
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
 * Scan for a Coyote 2.0 or 3.0 device and connect.
 * Starts the 100 ms command loop upon successful connection.
 */
export async function scanAndConnect(): Promise<void> {
  if (state.connected) {
    throw new Error('Already connected');
  }

  const bt = (navigator as any).bluetooth as any;
  const device: BluetoothDevice = await bt.requestDevice({
    filters: [{ namePrefix: V3_DEVICE_NAME_PREFIX }, { namePrefix: V2_DEVICE_NAME_PREFIX }],
    optionalServices: [
      V3_PRIMARY_SERVICE,
      V3_BATTERY_SERVICE,
      V2_PRIMARY_SERVICE,
      V2_BATTERY_SERVICE,
    ],
  });

  bleDevice = device;
  state.deviceName = device.name || '';
  state.address = device.id || '';
  device.addEventListener('gattserverdisconnected', onDisconnected);

  bleServer = await device.gatt.connect();

  // Detect device version from name
  const name = state.deviceName;
  deviceVersion = name.startsWith(V2_DEVICE_NAME_PREFIX) ? 2 : 3;
  console.log(`[bluetooth] detected Coyote ${deviceVersion}.0 — ${name}`);

  if (deviceVersion === 3) {
    // V3: single primary service with write & notify characteristics
    const primarySvc = await bleServer.getPrimaryService(V3_PRIMARY_SERVICE);
    writeChar = await primarySvc.getCharacteristic(V3_WRITE_CHAR);
    notifyChar = await primarySvc.getCharacteristic(V3_NOTIFY_CHAR);

    await notifyChar.startNotifications();
    notifyChar.addEventListener('characteristicvaluechanged', handleNotification);

    // Battery
    try {
      const batSvc = await bleServer.getPrimaryService(V3_BATTERY_SERVICE);
      batteryChar = await batSvc.getCharacteristic(V3_BATTERY_CHAR);
      await readBattery();
    } catch (_e) {
      console.warn('[bluetooth] battery service unavailable');
    }
  } else {
    // V2: separate characteristics for strength and per-channel waveform
    const primarySvc = await bleServer.getPrimaryService(V2_PRIMARY_SERVICE);
    v2StrengthChar = await primarySvc.getCharacteristic(V2_STRENGTH_CHAR);
    v2WaveAChar = await primarySvc.getCharacteristic(V2_WAVE_A_CHAR);
    v2WaveBChar = await primarySvc.getCharacteristic(V2_WAVE_B_CHAR);

    // Subscribe to strength notifications (PWM_AB2 supports Notify)
    await v2StrengthChar.startNotifications();
    v2StrengthChar.addEventListener('characteristicvaluechanged', handleV2StrengthNotification);

    // Battery
    try {
      const batSvc = await bleServer.getPrimaryService(V2_BATTERY_SERVICE);
      batteryChar = await batSvc.getCharacteristic(V2_BATTERY_CHAR);
      await readBattery();
    } catch (_e) {
      console.warn('[bluetooth] battery service unavailable');
    }
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

  if (deviceVersion === 3) {
    // V3: send default limits via BF and force strength to zero
    await writeBF(state.limitA, state.limitB);
    pendingStrA = 0;
    pendingStrB = 0;
    pendingMode = (3 << 2) | 3;
  } else {
    // V2: zero strength on connect (limits enforced client-side in v2Tick)
    await v2StrengthChar!.writeValueWithoutResponse(encodeV2Strength(0, 0));
  }

  // Start the continuous 100ms loop
  startTickLoop();

  notify();
}

/** V2 strength notification handler (PWM_AB2 notify). */
function handleV2StrengthNotification(event: Event): void {
  const target = event.target as BluetoothRemoteGATTCharacteristic;
  const dv = target.value;
  if (!dv || dv.byteLength < 3) return;

  const raw = (dv.getUint8(0) << 16) | (dv.getUint8(1) << 8) | dv.getUint8(2);
  const rawA = (raw >> 11) & 0x7ff;
  const rawB = raw & 0x7ff;

  // Map V2 0-2047 back to unified 0-200
  state.strengthA = Math.round((rawA * 200) / 2047);
  state.strengthB = Math.round((rawB * 200) / 2047);

  notify();
}

/**
 * Disconnect from the device and stop all loops.
 */
export async function disconnect(): Promise<void> {
  // Zero device strength before tearing down the connection, so the hardware
  // is not left at a non-zero value after a clean disconnect. Best-effort.
  waveState.A.active = false;
  waveState.B.active = false;
  pendingStrA = 0;
  pendingStrB = 0;

  if (deviceVersion === 3 && writeChar) {
    try {
      pendingMode = (3 << 2) | 3;
      const cmd = buildB0();
      await writeChar.writeValueWithoutResponse(cmd);
    } catch (_e) {
      /* best effort */
    }
  } else if (deviceVersion === 2 && v2StrengthChar) {
    try {
      await v2StrengthChar.writeValueWithoutResponse(encodeV2Strength(0, 0));
    } catch (_e) {
      /* best effort */
    }
  }

  stopTickLoop();

  // Unsubscribe notifications
  if (deviceVersion === 3 && notifyChar) {
    try {
      notifyChar.removeEventListener('characteristicvaluechanged', handleNotification);
      await notifyChar.stopNotifications();
    } catch (_e) {
      /* ignore */
    }
  } else if (deviceVersion === 2 && v2StrengthChar) {
    try {
      v2StrengthChar.removeEventListener(
        'characteristicvaluechanged',
        handleV2StrengthNotification,
      );
      await v2StrengthChar.stopNotifications();
    } catch (_e) {
      /* ignore */
    }
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
  if (!state.connected) throw new Error('设备未连接');
  const ch = String(channel || '').toUpperCase() as Channel;
  if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);
  const v = clamp(toInt(value, 0), 0, 200);
  if (ch === 'A') {
    pendingStrA = v;
    if (deviceVersion === 3) pendingMode = (pendingMode & 0x03) | (3 << 2);
  } else {
    pendingStrB = v;
    if (deviceVersion === 3) pendingMode = (pendingMode & 0x0c) | 3;
  }
}

/**
 * Relative strength change for a channel.
 * @param channel  'A' or 'B'
 * @param delta  positive = increase, negative = decrease
 */
export function addStrength(channel: string, delta: number): void {
  if (!state.connected) throw new Error('设备未连接');
  const ch = String(channel || '').toUpperCase() as Channel;
  if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);
  const d = toInt(delta, 0);
  if (d === 0) return;

  if (deviceVersion === 2) {
    // V2 has no relative mode — compute absolute target from current pending
    if (ch === 'A') {
      pendingStrA = clamp(pendingStrA + d, 0, 200);
    } else {
      pendingStrB = clamp(pendingStrB + d, 0, 200);
    }
  } else {
    const mode = d > 0 ? 1 : 2;
    const magnitude = clamp(Math.abs(d), 0, 200);
    if (ch === 'A') {
      pendingStrA = magnitude;
      pendingMode = (pendingMode & 0x03) | (mode << 2);
    } else {
      pendingStrB = magnitude;
      pendingMode = (pendingMode & 0x0c) | mode;
    }
  }
}

/**
 * Set strength limits and send BF command.
 * @param limitA  0-200
 * @param limitB  0-200
 */
export function setStrengthLimit(limitA: number, limitB: number): void {
  if (!state.connected) throw new Error('设备未连接');
  state.limitA = clamp(toInt(limitA, 0), 0, 200);
  state.limitB = clamp(toInt(limitB, 0), 0, 200);
  // V3: send BF command to hardware; V2: limits enforced client-side in v2Tick
  if (deviceVersion === 3) {
    writeBF(state.limitA, state.limitB).catch((err: unknown) => {
      console.error('[bluetooth] BF write error:', err);
    });
  }
  notify();
}

/**
 * Play a pre-built waveform on a channel.
 * @param channel  'A' or 'B'
 * @param frames   One frame per 100ms, each [encoded_freq, intensity(0-100)]
 * @param loop     Whether to loop playback
 */
export function sendWave(channel: string, frames: WaveFrame[], loop: boolean = false): void {
  if (!state.connected) throw new Error('设备未连接');
  const ch = String(channel || '').toUpperCase() as Channel;
  if (ch !== 'A' && ch !== 'B') throw new Error(`Invalid channel: ${channel}`);
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('sendWave: frames must be a non-empty array');
  }

  const ws = waveState[ch];
  ws.frames = frames.slice();
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
  if (!state.connected) throw new Error('设备未连接');
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
    connected: state.connected,
    deviceName: state.deviceName,
    address: state.address,
    battery: state.battery,
    strengthA: state.strengthA,
    strengthB: state.strengthB,
    limitA: state.limitA,
    limitB: state.limitB,
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

  // Set strength to zero
  pendingStrA = 0;
  pendingStrB = 0;

  // Send one final zero command immediately if possible
  if (deviceVersion === 3 && writeChar) {
    try {
      pendingMode = (3 << 2) | 3;
      const cmd = buildB0();
      writeChar.writeValueWithoutResponse(cmd);
    } catch (_) {
      /* best effort */
    }
  } else if (deviceVersion === 2 && v2StrengthChar) {
    try {
      v2StrengthChar.writeValueWithoutResponse(encodeV2Strength(0, 0));
    } catch (_) {
      /* best effort */
    }
  }

  notify();
}
