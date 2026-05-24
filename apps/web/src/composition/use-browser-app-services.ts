import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  createBrowserServices,
  type BrowserServices,
  type BrowserServicesOptions,
  type PermissionRequestInput,
} from '@dg-agent/agent-browser';
import type { MessageOrigin } from '@dg-agent/bridge';
import type { DeviceClient, PermissionDecision } from '@dg-agent/core';
import { CoyoteProtocolAdapter, WebBluetoothDeviceClient } from '@dg-agent/device-webbluetooth';
import type { BrowserAppSettings } from '@dg-agent/storage-browser';
import { BrowserUpdateChecker } from '../services/update-checker.js';

export interface PendingPermissionRequest {
  input: PermissionRequestInput;
  resolve: (decision: PermissionDecision) => void;
}

/**
 * Subset of BrowserServicesOptions a non-browser shell (Tauri Android) may
 * supply. Web entry point always omits this; defaults preserve the historical
 * Web Bluetooth + speech + bridge behavior.
 */
export type ServicesOverrides = Pick<
  BrowserServicesOptions,
  'createDeviceClient' | 'disableSpeech' | 'disableBridge'
> & {
  /** Skip the update-checker poll loop (no version.json on non-web shells). */
  disableUpdateChecker?: boolean;
};

export interface UseBrowserAppServicesOptions {
  settings: BrowserAppSettings;
  setPendingPermission: Dispatch<SetStateAction<PendingPermissionRequest | null>>;
  resolveBridgeSessionId: (origin: MessageOrigin) => string | null | Promise<string | null>;
  servicesOverrides?: ServicesOverrides;
}

export interface UseBrowserAppServicesResult extends BrowserServices {
  updateChecker: BrowserUpdateChecker;
  serviceInitWarnings: string[];
}

export function useBrowserAppServices(
  options: UseBrowserAppServicesOptions,
): UseBrowserAppServicesResult {
  const { resolveBridgeSessionId, settings, setPendingPermission, servicesOverrides } = options;

  const disableUpdateChecker = servicesOverrides?.disableUpdateChecker ?? false;
  const updateChecker = useMemo(
    () =>
      new BrowserUpdateChecker({
        currentBuildId: __BUILD_ID__,
        versionUrl: `${import.meta.env.BASE_URL}version.json`,
        disabled: disableUpdateChecker,
      }),
    [disableUpdateChecker],
  );

  // Build the device client once for the lifetime of the component. Settings
  // changes that rebuild the services (LLM client, bridge, permissions, …)
  // must not tear down the BLE connection — that used to disconnect users
  // every time they closed the settings drawer.
  const createDeviceClient = servicesOverrides?.createDeviceClient;
  const deviceRef = useRef<DeviceClient | null>(null);
  if (deviceRef.current === null) {
    const protocol = new CoyoteProtocolAdapter();
    deviceRef.current = createDeviceClient
      ? createDeviceClient(protocol)
      : new WebBluetoothDeviceClient({ protocol });
  }
  const device = deviceRef.current;

  const services = useMemo(
    () =>
      createBrowserServices({
        settings,
        device,
        resolveBridgeSessionId,
        onPermissionRequest: (input) =>
          new Promise<PermissionDecision>((resolve) => {
            setPendingPermission({ input, resolve });
          }),
        ...(servicesOverrides ?? {}),
      }),
    [settings, device, resolveBridgeSessionId, setPendingPermission, servicesOverrides],
  );

  // Release the previous AgentRuntime (device listener, in-flight turns,
  // scheduled timers) when settings cause a new services bundle to be built,
  // so listeners on the shared device don't accumulate.
  useEffect(() => {
    return () => {
      services.client.dispose?.();
    };
  }, [services]);

  return {
    ...services,
    updateChecker,
    serviceInitWarnings: services.warnings,
  };
}
