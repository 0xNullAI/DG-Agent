/**
 * Android lifecycle safety net.
 *
 * Coyote V3 is state-retentive: when the BLE link drops or no further B0
 * packets arrive, the device keeps running at its last commanded strength.
 * Browsers are forgiving — even backgrounded tabs keep timers ticking
 * (throttled but alive), so the tick loop writes a fresh B0 every 100 ms
 * and the device stays responsive to a UI stop.
 *
 * Android Tauri is not forgiving. When the user swipes home / locks the
 * screen, the WebView is suspended. setInterval and Workers stop. The
 * device just keeps running until either the user backgrounds long enough
 * for plugin-blec's GATT connection to drop (still: state-retentive), or
 * comes back to the app.
 *
 * This wrapper hooks the DeviceClient with browser + Tauri lifecycle
 * signals and fires `emergencyStop()` on every transition that takes the
 * app off-screen. It is a belt-and-braces: the JS side covers
 * `visibilitychange` / `pagehide` / `freeze`, and the Tauri Rust side
 * (lib.rs) emits a window event on Android's onPause for the cases where
 * the webview is suspended before JS gets a chance.
 */

import type { DeviceClient } from '@dg-agent/core';
import type {
  BluetoothDeviceLike,
  BluetoothRemoteGATTServerLike,
} from '@dg-agent/device-tauri-ble';

interface LifecycleListener {
  detach(): void;
}

/**
 * `TauriBlecDeviceClient` implements `DeviceClient` but also has an extra
 * `connectDevice()` passthrough (for the unified cross-kind picker) that
 * isn't part of the `DeviceClient` interface. Since this wrapper builds its
 * return value as an explicit object literal (deliberately, to avoid the
 * "spreading a class instance drops prototype methods" trap — see
 * `main.tsx`'s `withConnectPermissionHelp` doc comment for the general
 * version of that bug), any method not named here gets silently dropped.
 * `connectDevice` was added to `TauriBlecDeviceClient` after this wrapper
 * was written and wasn't added to the explicit list, so every Coyote
 * connection made through the unified picker failed with "当前环境不支持连接郊狼设备"
 * — `supportsConnectDevice()` in `connect-any-device-tauri.ts` checked the
 * wrapped client, found no `connectDevice`, and refused. Forwarding it here
 * (when present) closes that gap without giving up the explicit-list safety
 * this wrapper relies on elsewhere.
 */
interface ConnectDeviceCapable {
  connectDevice(device: BluetoothDeviceLike, server: BluetoothRemoteGATTServerLike): Promise<void>;
}

function hasConnectDevice(value: unknown): value is ConnectDeviceCapable {
  return !!value && typeof (value as Partial<ConnectDeviceCapable>).connectDevice === 'function';
}

type Stopper = () => Promise<void>;

function attachWebListeners(stop: Stopper): LifecycleListener {
  const onHidden = () => {
    if (document.visibilityState === 'hidden') {
      void stop();
    }
  };
  // pagehide covers iOS Safari / Tauri WebView teardown that doesn't fire
  // visibilitychange. freeze covers Chromium's bfcache eviction.
  const onPageHide = () => {
    void stop();
  };
  const onFreeze = () => {
    void stop();
  };

  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('freeze', onFreeze);

  return {
    detach() {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('freeze', onFreeze);
    },
  };
}

/**
 * Subscribe to a Tauri `app://paused` event emitted by lib.rs on the
 * Android onPause lifecycle. Returns a no-op listener if the @tauri-apps
 * runtime is not present (e.g. browser preview build).
 */
async function attachTauriListener(stop: Stopper): Promise<LifecycleListener> {
  type Unlistener = () => void;
  type TauriEventModule = {
    listen<T>(name: string, handler: (event: { payload: T }) => void): Promise<Unlistener>;
  };

  if (!('__TAURI_INTERNALS__' in window)) {
    return { detach: () => undefined };
  }
  try {
    const mod = (await import('@tauri-apps/api/event')) as unknown as TauriEventModule;
    const offPause = await mod.listen('app://paused', () => {
      void stop();
    });
    return { detach: () => offPause() };
  } catch {
    return { detach: () => undefined };
  }
}

/**
 * Wrap a `DeviceClient` so any lifecycle transition that suspends the
 * webview triggers an emergencyStop before suspension takes effect.
 * The returned object is a transparent proxy: every other method is
 * forwarded unchanged.
 */
export function wrapWithLifecycleSafety(
  client: DeviceClient,
): DeviceClient & Partial<ConnectDeviceCapable> {
  // Track the underlying client's connected state. Without this guard,
  // every lifecycle transition fires `client.emergencyStop()` — a no-op
  // when nothing is connected, but worse during connect-in-progress: if
  // the user backgrounds the app while plugin-blec's GATT discovery
  // retry loop is mid-flight, emergencyStop tries to write into a
  // half-initialised protocol state.
  let connected = false;
  const offState = client.onStateChanged((state) => {
    connected = state.connected;
  });

  let stopping = false;
  const stop: Stopper = async () => {
    if (!connected || stopping) return;
    stopping = true;
    try {
      await client.emergencyStop();
    } catch {
      // Best-effort — the device may already be unreachable. Swallow.
    } finally {
      // Allow the next transition (e.g. resume → backgrounded again) to
      // fire emergencyStop without being suppressed by the previous one.
      stopping = false;
    }
  };

  const webListener = attachWebListeners(stop);
  let tauriListener: LifecycleListener | null = null;
  void attachTauriListener(stop).then((l) => {
    tauriListener = l;
  });

  const wrapped: DeviceClient & Partial<ConnectDeviceCapable> = {
    connect: () => client.connect(),
    disconnect: async () => {
      try {
        await client.disconnect();
      } finally {
        webListener.detach();
        tauriListener?.detach();
        offState();
      }
    },
    execute: (command) => client.execute(command),
    emergencyStop: () => client.emergencyStop(),
    getState: () => client.getState(),
    onStateChanged: (l) => client.onStateChanged(l),
  };
  if (hasConnectDevice(client)) {
    wrapped.connectDevice = (device, server) => client.connectDevice(device, server);
  }
  return wrapped;
}
