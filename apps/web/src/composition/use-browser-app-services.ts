import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import {
  createBrowserServices,
  type BrowserServices,
  type BrowserServicesOptions,
  type PermissionRequestInput,
} from '@dg-agent/agent-browser';
import type { MessageOrigin } from '@dg-agent/bridge';
import type { DeviceClient, PermissionDecision } from '@dg-agent/core';
import {
  CoyoteProtocolAdapter,
  WebBluetoothCivetEdgingClient,
  WebBluetoothDeviceClient,
  WebBluetoothOpossumClient,
  WebBluetoothPawPrintsClient,
} from '@dg-agent/device-webbluetooth';
import type { CivetEdgingClient, OpossumClient, PawPrintsClient } from '@dg-agent/runtime';
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
  'createDeviceClient' | 'disableSpeech' | 'disableBridge' | 'freeProxySecret'
> & {
  /** Skip the update-checker poll loop (no version.json on non-web shells). */
  disableUpdateChecker?: boolean;
  /**
   * Override hooks for the three auxiliary device clients, mirroring
   * `createDeviceClient`'s pattern. Used by the Tauri Android shell to
   * inject `TauriBlecOpossumClient`/`TauriBlecPawPrintsClient`/
   * `TauriBlecCivetEdgingClient` (`@dg-kit/transport-tauri-blec`, via
   * `@dg-agent/device-tauri-ble`) instead of the Web-Bluetooth-backed
   * defaults. Only consulted when the corresponding client isn't already
   * pre-built (mirrors `createDeviceClient`'s "only used when `device` is
   * not supplied" rule at the `createBrowserServices()` level, one layer
   * further out — here it's "only used when this hook hasn't already built
   * one this render's lifetime").
   */
  createOpossumClient?: () => OpossumClient;
  createPawPrintsClient?: () => PawPrintsClient;
  createCivetEdgingClient?: () => CivetEdgingClient;
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
  //
  // autoReconnect is on by default: if the Coyote briefly drops the GATT
  // link (background WebView, brief out-of-range), the transport silently
  // reconnects via the cached BluetoothDevice rather than forcing the user
  // back to the chooser. The Tauri shell brings its own factory and decides
  // for itself.
  const createDeviceClient = servicesOverrides?.createDeviceClient;
  const deviceRef = useRef<DeviceClient | null>(null);
  if (deviceRef.current === null) {
    const protocol = new CoyoteProtocolAdapter();
    deviceRef.current = createDeviceClient
      ? createDeviceClient(protocol)
      : new WebBluetoothDeviceClient({ protocol, autoReconnect: true });
  }
  const device = deviceRef.current;

  // Same "build once, hold stable" pattern as `device` above — each of these
  // three auxiliary devices is independently connectable/disconnectable from
  // the UI, and settings-driven service rebuilds must not tear any of them
  // down. Override hooks mirror `createDeviceClient`: the Tauri Android
  // shell injects Tauri-backed clients instead of the Web-Bluetooth defaults.
  const createOpossumClient = servicesOverrides?.createOpossumClient;
  const opossumRef = useRef<OpossumClient | null>(null);
  if (opossumRef.current === null) {
    opossumRef.current = createOpossumClient
      ? createOpossumClient()
      : new WebBluetoothOpossumClient();
  }
  const opossum = opossumRef.current;

  const createPawPrintsClient = servicesOverrides?.createPawPrintsClient;
  const pawPrintsRef = useRef<PawPrintsClient | null>(null);
  if (pawPrintsRef.current === null) {
    pawPrintsRef.current = createPawPrintsClient
      ? createPawPrintsClient()
      : new WebBluetoothPawPrintsClient();
  }
  const pawPrints = pawPrintsRef.current;

  const createCivetEdgingClient = servicesOverrides?.createCivetEdgingClient;
  const civetEdgingRef = useRef<CivetEdgingClient | null>(null);
  if (civetEdgingRef.current === null) {
    civetEdgingRef.current = createCivetEdgingClient
      ? createCivetEdgingClient()
      : new WebBluetoothCivetEdgingClient();
  }
  const civetEdging = civetEdgingRef.current;

  const {
    createOpossumClient: _createOpossumClient,
    createPawPrintsClient: _createPawPrintsClient,
    createCivetEdgingClient: _createCivetEdgingClient,
    ...browserServicesOverrides
  } = servicesOverrides ?? {};

  const services = useMemo(
    () =>
      createBrowserServices({
        settings,
        device,
        opossum,
        pawPrints,
        civetEdging,
        resolveBridgeSessionId,
        onPermissionRequest: (input) =>
          new Promise<PermissionDecision>((resolve) => {
            setPendingPermission({ input, resolve });
          }),
        ...browserServicesOverrides,
      }),
    [
      settings,
      device,
      opossum,
      pawPrints,
      civetEdging,
      resolveBridgeSessionId,
      setPendingPermission,
      servicesOverrides,
    ],
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
