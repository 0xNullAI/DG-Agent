import type { RequestDeviceOptionsLike } from './types.js';

export const V3_DEVICE_NAME_PREFIX = '47L121';
export const V3_SENSOR_NAME_PREFIX = '47L120';
export const V3_PRIMARY_SERVICE = '0000180c-0000-1000-8000-00805f9b34fb';
export const V3_WRITE_CHAR = '0000150a-0000-1000-8000-00805f9b34fb';
export const V3_NOTIFY_CHAR = '0000150b-0000-1000-8000-00805f9b34fb';
export const V3_BATTERY_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
export const V3_BATTERY_CHAR = '00001500-0000-1000-8000-00805f9b34fb';

export const V2_DEVICE_NAME_PREFIX = 'D-LAB ESTIM';
export const v2Uuid = (short: string) => `955a${short}-0fe2-f5aa-a094-84b8d4f3e8ad`;
export const V2_PRIMARY_SERVICE = v2Uuid('180b');
export const V2_STRENGTH_CHAR = v2Uuid('1504');
export const V2_WAVE_A_CHAR = v2Uuid('1505');
export const V2_WAVE_B_CHAR = v2Uuid('1506');
export const V2_BATTERY_SERVICE = v2Uuid('180a');
export const V2_BATTERY_CHAR = v2Uuid('1500');

export const COYOTE_REQUEST_DEVICE_OPTIONS: RequestDeviceOptionsLike = {
  filters: [
    { namePrefix: V3_DEVICE_NAME_PREFIX },
    { namePrefix: V3_SENSOR_NAME_PREFIX },
    { namePrefix: V2_DEVICE_NAME_PREFIX },
  ],
  optionalServices: [
    V3_PRIMARY_SERVICE,
    V3_BATTERY_SERVICE,
    V2_PRIMARY_SERVICE,
    V2_BATTERY_SERVICE,
  ],
};
