# 架构决策

这份文档只记录当前已经落地、或者明确保留为未来边界的决策。

## 已确认

### 1. `runtime-first`

先把 `core / contracts / runtime` 站稳，再让 `web` 去组合这些能力。

原因：

- 避免再次出现“页面就是业务核心”
- 安全限制、tool loop、设备命令调度应当属于 runtime，而不是 UI
- 后续如果接 CLI / daemon / API，复用的核心也应该是 runtime

### 2. 浏览器优先（Browser-first）

当前主产品仍然是浏览器页面，不是 daemon，不是 Electron，也不是本地服务。

当前默认链路：

`apps/web -> AgentClient(embedded) -> runtime -> browser/device/provider adapters`

原因：

- 这仍然最符合真实用户使用方式
- Web Bluetooth 这种本地设备能力，本来就发生在浏览器
- 不能把主流程建立在“用户先安装本地 helper”这个前提上

### 3. `AgentClient` 作为页面唯一入口

页面层不直接依赖 `AgentRuntime`。

原因：

- `web` 只面向抽象 client，避免被 runtime 内部实现绑死
- future transport 可以替换，但页面调用面不变
- 页面层更容易保持“组合层”身份

### 4. 运行时继续按职责拆分

当前 `packages/runtime` 已明确拆分为：

- `agent-runtime`
- `runtime-tool-executor`
- `runtime-turn-state`
- `runtime-errors`

原因：

- `AgentRuntime` 应该保留主流程，不继续膨胀成“第二个巨石文件”
- tool 执行、turn 状态、错误归一化属于清晰的内部职责

### 5. 浏览器存储与桥接核心都要避免“单文件核心化”

当前已经明确拆分：

- `packages/storage-browser`
  - settings types
  - defaults
  - schema
  - settings store
  - session store
- `packages/bridge-core`
  - bridge types
  - message queue
  - permission port
  - bridge manager
  - bridge utils

原因：

- 这些模块本质上已经是独立逻辑域
- 继续堆在一个 `index.ts` 里，只会把可维护性问题推迟

### 6. 页面流程用 hooks 组织，而不是把行为继续堆在 `App.tsx`

当前前端组合层已经分出：

- `use-browser-app-services`
- `use-runtime-session-state`
- `use-waveform-manager`
- `use-voice-controller`

原因：

- 会话同步、语音流、波形库流都不是“渲染细节”
- 它们应当是无 UI 的前端行为模块

## 当前未交付，但保留边界

### 1. CLI

未来可以加 CLI，但当前仓库没有 `apps/cli` 交付物。

要求：

- 不允许为了 future CLI 反向污染当前 Web 主路径
- 只保留 runtime / client / contracts 边界即可

### 2. daemon / public API

当前仓库没有 daemon app 交付物。

保留边界的原则：

- 可以有 future daemon / public API
- 但不能把它们设计成“网页主流程的前提条件”
- 对外 API 更适合承载账号、同步、日志、云端能力，而不是直接控制用户本机蓝牙设备

### 3. Node 侧 BLE

当前不实现真机 Node BLE，只保留 `DevicePort` 边界。

原因：

- 真实路线还没收敛
- 当前优先级仍然是浏览器主路径与 runtime 护栏

## 当前实现形态

如果用“层 + 职责”来描述当前仓库：

- `apps/web`：组合层
- `packages/client`：调用抽象层
- `packages/runtime`：行为与安全核心
- `packages/device-*`：设备适配层
- `packages/providers-*`：模型适配层
- `packages/storage-browser`：浏览器状态持久化
- `packages/bridge-*`：桥接平台接入与桥接核心

这个形态比“单前端工程里塞所有逻辑”更接近目标状态。
