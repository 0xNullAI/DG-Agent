import { useMemo, type Dispatch, type SetStateAction } from 'react';
import {
  createBrowserServices,
  type BrowserServices,
  type BrowserServicesOptions,
  type PermissionRequestInput,
} from '@dg-agent/agent-browser';
import type { MessageOrigin } from '@dg-agent/bridge';
import type { PermissionDecision } from '@dg-agent/core';
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
>;

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

  const updateChecker = useMemo(
    () =>
      new BrowserUpdateChecker({
        currentBuildId: __BUILD_ID__,
        versionUrl: `${import.meta.env.BASE_URL}version.json`,
      }),
    [],
  );

  const services = useMemo(
    () =>
      createBrowserServices({
        settings,
        resolveBridgeSessionId,
        onPermissionRequest: (input) =>
          new Promise<PermissionDecision>((resolve) => {
            setPendingPermission({ input, resolve });
          }),
        ...(servicesOverrides ?? {}),
      }),
    [settings, resolveBridgeSessionId, setPendingPermission, servicesOverrides],
  );

  return {
    ...services,
    updateChecker,
    serviceInitWarnings: services.warnings,
  };
}
