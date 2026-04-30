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

The `gen/android/` directory is regenerated and gitignored. After every regeneration you must re-add to `gen/android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
<uses-feature android:name="android.hardware.bluetooth_le" android:required="true" />
```

And bump `gen/android/app/build.gradle.kts` `minSdk` to `26`.

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
TauriBlecDeviceClient (@dg-kit/transport-tauri-blec)
  ↓ scan + connect + (uuid, bytes) writes
@mnlphlp/plugin-blec (Tauri plugin)
  ↓ JNI
android.bluetooth.le.* (Android system BLE)
  ↓
DG-Lab Coyote 2.0 / 3.0
```
