# DG-Agent 架构文档

## 当前定位

- 主产品仍然是 `apps/web`
- 默认运行路径仍然是 **浏览器内嵌 runtime**
- Web Bluetooth 仍然是本地设备控制的主路径
- CLI / daemon / public API 目前只保留架构边界，不是当前交付物

## 核心架构

### 核心链路

`Web UI -> AgentClient(embedded) -> Runtime -> DeviceClient / LlmClient / PermissionService`

当前默认链路也可以表述为：

`apps/web -> AgentClient(embedded) -> runtime -> browser/device/provider adapters`

### 当前实现形态

如果用"层 + 职责"来描述当前仓库：

- `apps/web`：组合层
- `packages/client`：调用抽象层
- `packages/runtime`：行为与安全核心
- `packages/device-*`：设备适配层
- `packages/providers-*`：模型适配层
- `packages/storage-browser`：浏览器状态持久化
- `packages/bridge-*`：桥接平台接入与桥接核心

### 主要分层

- `apps/web`
  - 只负责组合依赖、展示状态、采集输入
  - 通过 hooks 组织会话、语音识别/合成、波形等前端流程
- `packages/client`
  - 提供 `AgentClient` 抽象
  - 隔离页面与 runtime / future transport
- `packages/runtime`
  - 负责会话编排、tool loop、策略执行、设备命令调度、运行时事件、session trace
  - 当前已拆为 `agent-runtime`、`runtime-tool-executor`、`runtime-turn-state`、`runtime-errors`、`session-trace`
- `packages/storage-browser`
  - 负责浏览器设置、会话存储与独立 trace 存储
  - 当前已拆为 settings store、session store、session trace store
- `packages/bridge-core`
  - 负责桥接平台抽象、消息队列、远程权限、桥接管理器
  - 当前已拆为 types / queue / permission / manager / utils
- `packages/device-*` / `packages/providers-*`
  - 分别承载平台设备适配与模型提供方适配

### 当前未交付，但保留边界

#### CLI

未来可以加 CLI，但当前仓库没有 `apps/cli` 交付物。

要求：

- 不允许为了 future CLI 反向污染当前 Web 主路径
- 只保留 runtime / client / contracts 边界即可

#### daemon / public API

当前仓库没有 daemon app 交付物。

保留边界的原则：

- 可以有 future daemon / public API
- 但不能把它们设计成"网页主流程的前提条件"
- 对外 API 更适合承载账号、同步、日志、云端能力，而不是直接控制用户本机蓝牙设备

## 当前消息模型与运行记录分层

当前实现已经收敛为三层：

- `session.messages`
  - 只持久化正常对话正文，主要是 `user / assistant`
- `session trace`
  - 持久化工具调用、执行结果、拒绝、失败、定时器等结构化记录
- `ephemeral trigger`
  - 定时器到期、工具拒绝 / 失败后的内部跟进提示，只用于触发下一轮模型收口，不写入会话正文

## 当前模型上下文策略

浏览器设置里目前提供 3 种策略：

- `截取到上一轮用户 prompt`
- `截取前五轮用户 prompt`
- `无限制`

默认值是 `截取到上一轮用户 prompt`。

## 已确认的架构决策

1. **runtime-first** — 先把 core / contracts / runtime 站稳，再让 web 去组合这些能力
2. **浏览器优先** — 当前主产品仍然是浏览器页面
3. **AgentClient 作为页面唯一入口** — 页面层不直接依赖 AgentRuntime
4. **运行时按职责拆分** — agent-runtime / runtime-tool-executor / runtime-turn-state / runtime-errors / session-trace
5. **存储与桥接避免单文件核心化** — 各自按逻辑域拆分
6. **页面流程用 hooks 组织** — 非渲染逻辑优先收敛为 hooks

## 架构护栏

### 依赖方向

主依赖方向：

`apps/web -> packages/client -> packages/runtime -> packages/contracts -> packages/core`

禁止：

- `runtime -> web`
- `runtime -> react`
- `core -> browser API`
- `web -> 直接操作设备协议`

### 页面层职责

`apps/web` 只负责：组合依赖、维护页面状态、订阅 runtime 事件、展示状态与采集输入、调用 AgentClient

`apps/web` 不负责：tool schema 定义、策略判定、命令串行、设备协议、provider HTTP 请求拼装

### 消息与 trace 护栏

- `session.messages` 只保留正常聊天正文
- tool result / deny / fail / timer 等运行记录写入 trace
- 禁止把内部系统提示长期持久化到 `session.messages`
- 禁止把工具输出伪装成原始聊天消息塞回 history

## 目录

```text
apps/
  web/                     当前主产品

packages/
  api-contracts/           API DTO 与路由契约
  audio-browser/           浏览器语音识别 / 语音合成适配
  bridge-browser/          浏览器侧桥接适配器
  bridge-core/             桥接核心逻辑
  client/                  AgentClient 抽象
  contracts/               接口契约
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

aliyun-fc/                 阿里云 FC 免费代理函数
docs/                      文档
```
