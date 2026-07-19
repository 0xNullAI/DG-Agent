# @dg-agent/tauri-android

Tauri 2 Android wrapper for DG-Agent.

## Why this exists

Android WebView does not implement Web Bluetooth. We wrap the existing React app in a Tauri shell and swap the device transport for [`@mnlphlp/plugin-blec`](https://github.com/MnlPhlp/tauri-plugin-blec) (BLE via Android native APIs).

The web app under `apps/web` is reused verbatim — `App.tsx` accepts an optional `servicesOverrides` prop, and this shell passes:

- `createDeviceClient`: returns `TauriBlecDeviceClient` from `@dg-agent/device-tauri-ble`
- `disableSpeech: true` (no DashScope ASR/TTS or browser SpeechRecognition on Android)
- `disableBridge: true` (no QQ NapCat or Telegram bridges on Android)

## Prerequisites

- Rust 1.78+ with Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- Android SDK with platform 34/35/36 + build-tools 34/35
- Android NDK 26.x (set `NDK_HOME` or `ANDROID_NDK_HOME`)
- `cargo install tauri-cli --version "^2"`
- Java 17+

Set environment:

```bash
export ANDROID_HOME=$HOME/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export NDK_HOME=$ANDROID_HOME/ndk/26.1.10909125
```

## First-time setup

```bash
cd apps/tauri-android
cargo tauri android init      # regenerates src-tauri/gen/android/
# After init, re-apply BLE permissions to AndroidManifest.xml — see below.
```

The `gen/android/` directory is regenerated and gitignored. After every regeneration:

1. Copy the `<uses-permission>` / `<uses-feature>` block from
   [`AndroidManifest.template.xml`](./AndroidManifest.template.xml) into
   `gen/android/app/src/main/AndroidManifest.xml` (inside `<manifest>` root,
   before `<application>`). The template explains each permission.
2. Bump `gen/android/app/build.gradle.kts` `minSdk` to `26` (required by
   `@mnlphlp/plugin-blec`'s Android backend).
3. Re-apply the release-signing config from
   [`signing.gradle.kts.template`](./signing.gradle.kts.template) into
   `gen/android/app/build.gradle.kts` — see "Release builds" below for why
   this is needed and what it reads.

## Release builds

`gen/android/` is regenerated from scratch by `cargo tauri android init` and
is gitignored, so the release-signing config isn't checked in anywhere — it
has to be re-applied by hand after every regeneration (step 3 above), reading
from [`signing.gradle.kts.template`](./signing.gradle.kts.template).

To produce an installable release APK, set these environment variables
before building (keystore path + passwords are kept outside the repo, not
committed anywhere):

```bash
export DG_AGENT_KEYSTORE=/path/to/dg-agent-release.jks
export DG_AGENT_ALIAS=dg-agent
export DG_AGENT_STORE_PASS=...
export DG_AGENT_KEY_PASS=...
npm run android:build -- --apk --target aarch64
```

Without these set, `signingConfigs.release` has no `storeFile`, and Gradle
either fails on the release build type or (for `debug`) it doesn't matter —
debug builds always use the Android debug key regardless.

## Develop

```bash
npm run android:dev   # tauri android dev — installs on a connected device
```

## Build APK

```bash
npm run android:build -- --apk
# APK at src-tauri/gen/android/app/build/outputs/apk/universal/{debug,release}/
```

## Architecture

```
React UI (apps/web/src/App.tsx, reused via vite alias)
  ↓
@dg-agent/agent-browser createBrowserServices({ createDeviceClient: ... })
  ↓
wrapWithLifecycleSafety  ← Android safety net (see below)
  ↓
TauriBlecDeviceClient (@dg-kit/transport-tauri-blec)
  ↓ scan + connect + (uuid, bytes) writes
@mnlphlp/plugin-blec (Tauri plugin)
  ↓ JNI
android.bluetooth.le.* (Android system BLE)
  ↓
DG-Lab Coyote 2.0 / 3.0
```

### Lifecycle safety

Coyote V3 is state-retentive: once a strength is commanded, the device keeps running until a new packet arrives — _not_ until the BLE link drops. On a normal browser tab this is invisible because the page's `setInterval` keeps ticking out new packets (throttled but alive) even when backgrounded.

Android Tauri is different: when the user swipes home / locks the screen, the host activity hits `onPause` and the WebView is suspended. JS timers stop. The device keeps running at the last commanded strength until the BLE link eventually drops, which can take a long time.

[`src/lifecycle-safety.ts`](./src/lifecycle-safety.ts) wraps the `TauriBlecDeviceClient` so any backgrounding signal fires `emergencyStop()` before the WebView is suspended. Signals covered:

- `document.visibilitychange` → state becomes `hidden` (Android WebView reliably emits this on host onPause)
- `window.pagehide` (Tauri navigation / app teardown)
- `document.freeze` (Chromium bfcache eviction)
- Tauri `app://paused` event from `lib.rs` on `RunEvent::ExitRequested` (belt-and-braces)

The wrapper is transparent: every method except `disconnect()` forwards unchanged. `disconnect()` additionally detaches the listeners so they don't leak across reconnects.
