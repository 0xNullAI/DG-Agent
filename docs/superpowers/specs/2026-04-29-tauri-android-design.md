# DG-Agent Tauri Android 封装 — 设计文档

- **日期**：2026-04-29
- **作者**：leonardoshen / Claude
- **状态**：Draft（待用户评审）
- **跨仓库范围**：DG-Agent (`feat/tauri-android`) + DG-Kit (`feat/transport-tauri-blec`)

## 1. 目标与非目标

### 目标

1. 用 Tauri 2 把 DG-Agent 封装成 Android App，能在手机上完成"AI 对话 → 工具调用 → BLE 控制郊狼设备"的完整闭环。
2. **网页版功能与代码零破坏**：`apps/web` 不动，runtime / policy / tool executor / providers / storage / waveforms 等核心包全部不动。
3. 全部新增代码集中在 1 个新 Tauri 应用 + 2 个新包（DG-Kit 1 个、DG-Agent 1 个 shim）+ 1 处 5～15 行的 factory 改动。

### 非目标（明确不做）

- iOS / Tauri 桌面打包（架构兼容，但本期不验证）
- Android 上的语音输入/输出（DashScope ASR/TTS + 浏览器 SpeechRecognition）
- Android 上的 QQ NapCat / Telegram bridge
- Android 通知、后台保活、应用内更新
- Google Play 上架流程（仅产出 APK 用于侧载分发）

## 2. 关键技术决策

### 2.1 BLE 插件：`@mnlphlp/plugin-blec`

- 对比过 `26F-Studio/tauri-plugin-bluetooth`（4★、半年没动）、`ParticleG/tauri-plugin-web-bluetooth-api`（移动端 `UnsupportedPlatform`）、直接用 `btleplug`（需自行实现 droidplug + JNI 桥接 + ProGuard + 权限流，等于重写 plugin-blec）。
- plugin-blec 215★、活跃维护（2026-04-21 提交）、btleplug 上游官方推荐的 Tauri 集成方式、桌面/iOS 复用 btleplug 生态。
- **风险**：Android OEM BLE 栈差异（小米 / 华为）—— 任何 BLE 库都躲不掉，对策是把它藏在 `BluetoothRemoteGATTCharacteristicLike` 接口后面，必要时可零破坏地切换底层。

### 2.2 抽象层归属：在 DG-Kit 加传输层

- DG-Kit 早就有 `@dg-kit/transport-webbluetooth`，命名约定指向"按运行时分包"。
- 新增 `@dg-kit/transport-tauri-blec`，与 web 版并列，复用 `@dg-kit/protocol` 的 `BluetoothRemoteGATTCharacteristicLike` 抽象。
- DG-Agent 侧只增加一个 10 行 shim 包（镜像现有 `device-webbluetooth` 模式）。

### 2.3 服务工厂的复用：参数化注入而非 fork

- `createBrowserServices` 已经是 DG-Agent 的服务装配中心。
- 加 3 个**可选**参数（`createDeviceClient` / `disableSpeech` / `disableBridge`），默认值与现行行为完全一致。
- `apps/web` 不需要改一行；`apps/tauri-android` 在调用时传入 Tauri 适配。

## 3. 架构图

```
┌─────────────────────────────────────────────────────────────────┐
│ DG-Kit                                                          │
│                                                                 │
│   @dg-kit/core                                                  │
│   @dg-kit/protocol  ── BluetoothRemoteGATTCharacteristicLike    │
│                              ▲              ▲                   │
│   @dg-kit/transport-webbluetooth (不动)     │                   │
│                                             │                   │
│   @dg-kit/transport-tauri-blec  ★ NEW ──────┘                   │
│      └─ TauriBlecDeviceClient                                   │
│         内部用 @mnlphlp/plugin-blec 实现 GATT 抽象               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ DG-Agent                                                        │
│                                                                 │
│   packages/device-webbluetooth/      (不动)                      │
│   packages/device-tauri-ble/         ★ NEW（10 行 shim）        │
│   packages/agent-browser/            ◇ 改 1 文件，~15 行         │
│   packages/audio-browser/            (不动)                      │
│   packages/bridge/                   (不动)                      │
│   其他所有包                          (不动)                     │
│                                                                 │
│   apps/web/                          (不动)                      │
│   apps/tauri-android/                ★ NEW                       │
│      ├─ src/                                                    │
│      │   ├─ main.tsx       入口，调 createBrowserServices        │
│      │   ├─ App.tsx        复用 apps/web 的 App 组件             │
│      │   └─ components/                                         │
│      │       └─ DevicePicker.tsx   Tauri 端独有的设备选择 Modal  │
│      └─ src-tauri/         Rust + plugin-blec + Android 配置     │
└─────────────────────────────────────────────────────────────────┘
```

## 4. 包详细设计

### 4.1 `@dg-kit/transport-tauri-blec`（新增）

**路径**：`DG-Kit/packages/transport-tauri-blec/`

**API**（与 `transport-webbluetooth` 对称）：

```ts
// availability.ts
export function getTauriBlecAvailability(): {
  supported: boolean;
  reason?: string;
};

// client.ts
export interface TauriBlecDeviceClientOptions {
  protocol: WebBluetoothProtocolAdapter;
  /**
   * 由 UI 注入：给定扫描到的设备列表，返回用户选中的设备 address。
   * Web Bluetooth 由浏览器原生 chooser 完成，Tauri 端必须由调用方提供。
   */
  selectDevice: (devices: DiscoveredDevice[]) => Promise<string | null>;
  scanDurationMs?: number; // 默认 8000
  scanFilter?: { services?: string[]; namePrefix?: string };
}

export interface DiscoveredDevice {
  address: string;
  name: string | null;
  rssi: number | null;
  serviceUuids: string[];
}

export class TauriBlecDeviceClient implements DeviceClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(command: DeviceCommand): Promise<DeviceCommandResult>;
  subscribe(listener: (state: DeviceState) => void): () => void;
}

// index.ts
export { getTauriBlecAvailability } from './availability.js';
export {
  TauriBlecDeviceClient,
  type TauriBlecDeviceClientOptions,
  type DiscoveredDevice,
} from './client.js';
```

**内部实现要点**：

- `connect()` 流程：`startScan()` → 收集设备列表 → 调 `selectDevice` 让 UI 选 → `connect(address)` → 包装 plugin-blec 的 characteristic 句柄成 `BluetoothRemoteGATTCharacteristicLike` → 喂给 `protocol.onConnected({...})`。
- `subscribe()`：plugin-blec 的 notify 回调 → `protocol` 的 state stream → 转发给 listeners。
- 断连：plugin-blec 的 disconnect 回调 → 触发 protocol 的 `onDisconnected()`，与 Web 版保持同样的状态机。

**依赖**：

- `@dg-kit/core`（peer）、`@dg-kit/protocol`（peer）
- `@mnlphlp/plugin-blec`（runtime）

**测试**：

- 单元：mock plugin-blec，覆盖"扫描成功 → 用户取消 → 错误"、"连接 → 断连重连"、"写帧序列保持 25ms 节奏"
- 集成：手动真机冒烟，覆盖在阶段 0 任务里

### 4.2 `@dg-agent/device-tauri-ble`（新增 shim）

**路径**：`DG-Agent/packages/device-tauri-ble/`

**内容**（10 行）：

```ts
// src/index.ts
export * from '@dg-kit/protocol';
export * from '@dg-kit/transport-tauri-blec';
```

`package.json` 镜像 `device-webbluetooth`：

```json
{
  "name": "@dg-agent/device-tauri-ble",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "dependencies": {
    "@dg-agent/core": "0.1.0",
    "@dg-kit/protocol": "^1.0.1",
    "@dg-kit/transport-tauri-blec": "^1.0.1"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

### 4.3 `@dg-agent/agent-browser` 改动（精确清单）

**唯一被改的文件**：`packages/agent-browser/src/create-browser-services.ts`

**改动 1**：扩展 `BrowserServicesOptions`：

```ts
export interface BrowserServicesOptions {
  // ...全部原有字段不变
  createDeviceClient?: (protocol: CoyoteProtocolAdapter) => DeviceClient;
  disableSpeech?: boolean;
  disableBridge?: boolean;
}
```

**改动 2**：device 构造分支（替换原本直接 `new WebBluetoothDeviceClient(...)` 那行）：

```ts
const deviceProtocol = new CoyoteProtocolAdapter();
const device = options.createDeviceClient
  ? options.createDeviceClient(deviceProtocol)
  : new WebBluetoothDeviceClient({ protocol: deviceProtocol });
```

**改动 3**：speech 分支：

```ts
const speechCapabilities = options.disableSpeech
  ? { supported: false, recognitionSupported: false, synthesisSupported: false, ... }
  : getBrowserSpeechCapabilities();

const speechRecognition = options.disableSpeech
  ? createNullSpeechRecognitionController()
  : createSpeechRecognitionController({ ... });
// speechSynthesizer 同理
```

需要在 `@dg-agent/audio-browser` 加一个 `createNullSpeechRecognitionController()` / `createNullSpeechSynthesizer()`（返回与现有接口同形的 no-op 实现，~30 行）。

**改动 4**：bridge 分支：

```ts
const bridgeManager = options.disableBridge
  ? createNullBridgeManager()
  : new BridgeManager({ ... });
```

需要在 `@dg-agent/bridge` 加一个 `createNullBridgeManager()` 工厂返回 no-op（~30 行，方法都返回 resolved Promise / 空数组 / 空订阅）。

**净行数估算**：

- `create-browser-services.ts`：+15 行
- `audio-browser` no-op：+30 行
- `bridge` no-op：+30 行
- **共 ~75 行新增，0 行删除/修改原有逻辑**

`apps/web` 不调用任何新参数 → 行为与改动前 100% 等价。

### 4.4 `apps/tauri-android`（新增）

**目录结构**：

```
apps/tauri-android/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/
│   ├── main.tsx              入口
│   ├── App.tsx               薄壳，复用 apps/web 的 App
│   ├── tauri-device-client.ts 适配 createDeviceClient
│   ├── components/
│   │   └── DevicePicker.tsx  扫描 + 选择 UI
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json      包含 blec:default 权限
    ├── src/
    │   ├── main.rs
    │   └── lib.rs            init blec plugin
    └── gen/android/          tauri android init 生成
        └── app/src/main/AndroidManifest.xml  (BLUETOOTH_SCAN/CONNECT)
```

**`main.tsx` 关键代码**：

```tsx
import { createBrowserServices } from '@dg-agent/agent-browser';
import { TauriBlecDeviceClient } from '@dg-agent/device-tauri-ble';
import { showDevicePicker } from './components/DevicePicker';
import App from './App';

const services = createBrowserServices({
  settings,
  onPermissionRequest,
  resolveBridgeSessionId: () => null,
  disableSpeech: true,
  disableBridge: true,
  createDeviceClient: (protocol) =>
    new TauriBlecDeviceClient({
      protocol,
      selectDevice: showDevicePicker,
    }),
});

// ...同 apps/web/src/main.tsx 后续逻辑
```

**`App.tsx`**：直接 `import App from '../../web/src/App'`，或把 `apps/web/src/App.tsx` 抽到一个共享路径。具体做法在阶段 1 评估两种方案的取舍：

- 方案 A：path alias 引用，零文件移动，apps/web 不动
- 方案 B：把 `App.tsx` 提到一个新包 `@dg-agent/app-shell`，两边都从这里 import

**推荐 A**，符合"尽量不动 web"原则。

**`DevicePicker.tsx` 行为**：

- Mount 时调 `plugin-blec.startScan()`，订阅设备 stream
- 列表展示 name + rssi + signal bars，按 rssi 排序
- 5 秒还没设备时显示提示"未发现设备，请确认设备已开机并按住按键开启广播"
- 点击某行 → resolve outer Promise 返回 address；取消 → resolve null

**Tauri 配置要点**：

- `tauri.conf.json` `app.security.csp` 允许 `tauri://` 自身
- `capabilities/default.json` 加入 `"blec:default"`
- `AndroidManifest.xml` 加 `BLUETOOTH_SCAN`、`BLUETOOTH_CONNECT`、`ACCESS_FINE_LOCATION`（API ≤ 30）
- minSdkVersion = 26（plugin-blec 要求）

### 4.5 不需要改动的部分（清单）

| 包 / 路径                                                                                                                      | 改动 |
| ------------------------------------------------------------------------------------------------------------------------------ | ---- |
| `DG-Kit/packages/{core,protocol,waveforms,tools,transport-webbluetooth}`                                                       | 0    |
| `DG-Agent/packages/{runtime,client,core,providers-*,storage-browser,waveforms,permissions-browser,bridge,device-webbluetooth}` | 0    |
| `DG-Agent/apps/web/`                                                                                                           | 0    |
| `DG-Agent/aliyun-fc/`                                                                                                          | 0    |

`bridge` 和 `audio-browser` 各加一个新文件（no-op 工厂），但**不修改任何现有文件**。

## 5. 数据流

```
用户在 Android 上点"连接设备"
   └─> App.tsx 调用 services.client.connectDevice()
        └─> TauriBlecDeviceClient.connect()
             ├─ plugin-blec.startScan()
             │    └─ Rust 侧 → JNI → Android BluetoothLeScanner
             ├─ DevicePicker 显示扫描列表
             ├─ 用户点击 → resolve address
             ├─ plugin-blec.connect(address)
             ├─ 包装 characteristic 为 BluetoothRemoteGATTCharacteristicLike
             └─ CoyoteProtocolAdapter.onConnected({device, server})
                  └─ 之后所有写帧/notify 走与网页版完全相同的路径
```

LLM 工具调用 → runtime → tool executor → DeviceClient.send() → 协议层（与网页版同一份代码）→ characteristic.writeValue() → plugin-blec → Android BLE → 郊狼。

## 6. 错误处理与降级

| 场景                                   | 处理                                                                                          |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| Tauri 环境检测不到 plugin-blec         | `getTauriBlecAvailability()` 返回 `{supported:false, reason:'…'}`，UI 显示连接按钮禁用 + 提示 |
| Android 蓝牙未开启                     | plugin-blec 抛错 → catch → 弹 toast "请打开蓝牙"                                              |
| 用户拒绝 BLE 权限                      | 同上，提示去系统设置授权                                                                      |
| 扫描超时无设备                         | DevicePicker 显示提示文案 + 刷新按钮                                                          |
| 连接成功后 Android 主动断开（OEM bug） | plugin-blec disconnect callback → protocol.onDisconnected → UI 提示并允许重连                 |
| 写帧失败（characteristic 不可用）      | 与 Web 版同样的 protocol 层错误处理路径                                                       |

## 7. 测试策略

### 单元测试

- `transport-tauri-blec`：mock plugin-blec，覆盖扫描/选择/连接/写/订阅/断连
- `agent-browser`：新增 `disableSpeech` / `disableBridge` 路径的工厂测试
- `audio-browser` no-op：基本可用性
- `bridge` no-op：基本可用性

### 真机冒烟（必须）

阶段 0 在以下机型至少各一台：

1. Pixel 系列（原生 Android，基线）
2. 小米 / Redmi（HyperOS / MIUI BLE 栈）
3. 华为 / 荣耀（HarmonyOS BLE 栈）

每台跑：扫描 → 看到郊狼 → 连接 → 写 1 帧 → 收 notify → 主动断开 → 重连。

### CI

- Lint + typecheck 全 monorepo（Tauri Android 不在 CI 构建，仅本地）
- Vitest 全 monorepo
- Tauri Android 构建标记为可选 job，本地运行

## 8. 分阶段实施

**阶段 0（必须先于一切）— 真机 PoC（1～2 天）**

- 起一个最小 Tauri Android 工程，集成 plugin-blec
- 写死郊狼 service UUID，跑 scan + connect + 写一帧 + 收 notify
- 在三类机型上验证
- **如果失败**：进入 Plan B（fork plugin-blec 修 / 自写薄插件 / 派生 ParticleG 加 Android）→ 不进入下一阶段

**阶段 1 — DG-Kit 传输层（2～3 天）**

- 新建 `@dg-kit/transport-tauri-blec`
- 实现 + 单元测试
- 写 changeset，发 PR 到 DG-Kit `main`

**阶段 2 — DG-Agent shim 与 factory 改动（1 天）**

- 新建 `@dg-agent/device-tauri-ble`
- 改 `agent-browser` factory，加 no-op 工厂
- 跑全量测试，确保 `apps/web` 行为零变化
- 发 PR 到 DG-Agent `dev`

**阶段 3 — Tauri Android 应用（3～5 天）**

- 新建 `apps/tauri-android`
- 写 DevicePicker 和 main 入口
- 真机端到端调通
- 出第一份 APK

**阶段 4 — 打磨（按需）**

- Android 系统主题适配（深色模式）
- BLE 重连 UX 优化
- 应用图标、启动画面
- APK 签名脚本

## 9. Plan B（plugin-blec 在真机上不工作时）

按代价从低到高：

1. **Fork plugin-blec 修复**：Kotlin + Rust 都开源，作者活跃
2. **派生 ParticleG/tauri-plugin-web-bluetooth-api**：给它补 Android 实现，享受 Web Bluetooth API 镜像带来的"零适配层"收益（`@dg-agent/device-webbluetooth` 都不用换，直接复用网页代码）
3. **自写最薄 Tauri 插件**：Kotlin 直接调 `android.bluetooth.le.*`，只暴露 scan/connect/write/subscribe，约 300～500 行 Kotlin

`BluetoothRemoteGATTCharacteristicLike` 抽象层让以上任何切换都只动 `transport-tauri-blec` 一个包。

## 10. 已识别的不确定项

- **plugin-blec 的设备 disconnect callback 时序**：是否在 connect 之前注册可靠？需要 PoC 验证。
- **plugin-blec 的写节奏**：郊狼协议 V3 要求每 100 ms 写 4 帧，需要测试 plugin-blec 在 Android 上的 write throughput 是否稳定。
- **Tauri 2 Android 的 React Hot Reload**：Vite dev server 走 USB / WiFi 转发的稳定性，可能需要约定开发流程。
- **APK 大小**：Tauri 应用 + plugin-blec + React bundle 预估 15-25 MB，可接受。

## 11. 不在本设计内但相关的未来工作

- iOS 构建（plugin-blec 已支持）
- Tauri 桌面构建（替代 Electron 路径，复用同一套 Rust 后端）
- Android 原生语音 API 接入（如果用户反馈强烈）
- 应用商店上架（Play Store / 国内厂商商店）
