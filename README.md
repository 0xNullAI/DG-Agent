# DG-Agent

这是 `DG-Agent` 的实验仓库。


## 当前定位

- 主产品仍然是 `apps/web`
- 默认运行路径仍然是 **浏览器内嵌 runtime**
- Web Bluetooth 仍然是本地设备控制的主路径
- CLI / daemon / public API 目前只保留架构边界，不是当前交付物

## 当前架构

核心链路：

`Web UI -> AgentClient(embedded) -> Runtime -> DevicePort / LlmPort / PermissionPort`

主要分层：

- `apps/web`
  - 只负责组合依赖、展示状态、采集输入
  - 通过 hooks 组织会话、语音、波形等前端流程
- `packages/client`
  - 提供 `AgentClient` 抽象
  - 隔离页面与 runtime / future transport
- `packages/runtime`
  - 负责会话编排、tool loop、策略执行、设备命令调度、运行时事件
  - 当前已拆为 `agent-runtime`、`runtime-tool-executor`、`runtime-turn-state`、`runtime-errors`
- `packages/storage-browser`
  - 负责浏览器设置与会话存储
  - 当前已拆为 settings types/defaults/schema/store 与 session store
- `packages/bridge-core`
  - 负责桥接平台抽象、消息队列、远程权限、桥接管理器
  - 当前已拆为 types / queue / permission / manager / utils
- `packages/device-*` / `packages/providers-*`
  - 分别承载平台设备适配与模型提供方适配

## 目录

```text
apps/
  web/                     当前主产品

packages/
  api-contracts/           API DTO 与路由契约
  audio-browser/           浏览器语音输入 / TTS 适配
  bridge-browser/          浏览器侧桥接适配器
  bridge-core/             桥接核心逻辑
  client/                  AgentClient 抽象
  contracts/               端口定义
  core/                    领域模型与共享类型
  device-webbluetooth/     浏览器蓝牙设备适配
  permissions-basic/       基础权限策略适配
  permissions-browser/     浏览器权限适配
  prompts-basic/           基础提示词预设
  providers-catalog/       Provider 元数据与归一化
  providers-openai-http/   OpenAI / 兼容 HTTP Provider 适配
  runtime/                 核心运行时
  safety-browser/          浏览器安全守卫
  storage-browser/         浏览器设置 / 会话存储
  testkit/                 Fake adapters / fixtures
  theme-browser/           主题适配
  update-browser/          浏览器更新检查
  waveforms-basic/         内置波形库
  waveforms-browser/       浏览器波形导入 / 存储

docs/
  architecture-decisions.md
  architecture-guardrails.md
```

## 开发命令

- 安装依赖：`npm install`
- 启动 Web：`npm run dev`
- 类型检查：`npm run typecheck`
- 逻辑验证：`npm run test`

## 当前验证方式

当前逻辑层验证以 **workspace typecheck + package self-test** 为主：

- `packages/runtime`
- `packages/bridge-core`
- `packages/storage-browser`
- `packages/providers-catalog`

## 当前约束

- `apps/web` 不直接实现设备协议
- `apps/web` 不直接 new `AgentRuntime`
- `runtime` 不依赖 React / Vite / 浏览器页面状态
- `core` 不依赖浏览器 API 和 Node API
- 新能力优先长在 `runtime / adapter / store`，而不是继续堆进页面组件

## 文档

- 决策说明：`docs/architecture-decisions.md`
- 护栏说明：`docs/architecture-guardrails.md`
