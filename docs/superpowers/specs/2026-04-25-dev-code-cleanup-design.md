# Dev 代码清洁设计文档

**日期**：2026-04-25  
**状态**：已实施。

> **历史背景**：本 spec 完成后，同日做了一次包结构重组（见
> `2026-04-25-package-restructure-design.md`），其中 `permissions-browser`
> 合并进 `permissions`、`prompts-basic` 内嵌进 `runtime`。下文中出现的
> 这两个旧包名仅作历史记录，对应能力现位于新包内。

**范围**：`apps/web` + `packages/runtime` + `packages/providers-openai-http` + `packages/permissions-browser` + `packages/prompts-basic`  
**目标**：拆分大文件、补充测试防护网，不引入新功能，不改变任何现有行为。

---

## 优先级列表

| 优先级 | 项目                                  | 类型 | 当前行数 → 目标 |
| ------ | ------------------------------------- | ---- | --------------- |
| 1      | `App.tsx` 组件拆分                    | 重构 | 1144 → ~600     |
| 2      | `providers-openai-http/index.ts` 拆分 | 重构 | 697 → ~250      |
| 3      | `agent-runtime.ts` helper 提取        | 重构 | 828 → ~650      |
| 4      | `permissions-browser` 补测试          | 测试 | 0 → ~80 行测试  |
| 5      | `build-browser-instructions` 补测试   | 测试 | 0 → ~80 行测试  |
| 6      | `prompts-basic` 补测试                | 测试 | 0 → ~40 行测试  |

---

## 第一项：`App.tsx` 组件拆分

### 问题

`apps/web/src/App.tsx` 1144 行，将 hook 胶水代码、业务逻辑与 4 段大型 JSX 渲染混在一起，日常开发频繁改动此文件，维护成本高。

### 方案

提取 4 个纯 UI 组件到 `apps/web/src/components/`，所有新组件只通过 props 接收数据，不引入新状态，不改任何 UI 行为或 CSS 类名。

#### `SettingsDrawer.tsx`（~280 行）

提取内容：

- `renderSettingsSidebar()` 函数体（桌面端设置侧边栏）
- `renderSettingsWorkspace()` 函数体（设置内容区）
- `SETTINGS_NAV_ITEMS` 常量
- `SETTINGS_NAV_GROUPS` 常量
- `SettingsModalTab` 类型定义

Props 接口：

```ts
interface SettingsDrawerProps {
  tab: SettingsModalTab;
  onTabChange: (tab: SettingsModalTab) => void;
  mobileNavOpen: boolean;
  onMobileNavOpenChange: (open: boolean) => void;
  onClose: () => void;
  onRequestReset: () => void;
  settingsDraft: AppSettings;
  setSettingsDraft: React.Dispatch<React.SetStateAction<AppSettings>>;
  onDeleteSavedPromptPreset: (id: string) => void;
  waveforms: Waveform[];
  customWaveforms: CustomWaveform[];
  onImportWaveforms: (files: FileList) => void;
  onRemoveWaveform: (id: string) => void;
  onEditWaveform: (waveform: EditingWaveform) => void;
  bridgeLogs: BridgeLogEntry[];
  bridgeStatus: BridgeManagerStatus | null;
  events: RuntimeEvent[];
  settings: AppSettings;
}
```

#### `FloatingStatusBar.tsx`（~100 行）

提取内容：`floatingStatus` JSX 变量（语音状态卡片 + 错误/警告/事件 toast + 更新提示）

Props 接口：

```ts
interface FloatingStatusBarProps {
  voiceMode: boolean;
  voiceState: 'idle' | 'listening' | 'speaking';
  voiceTranscript: string;
  errorItems: ToastItem[];
  warnings: ToastItem[];
  eventToasts: ToastItem[];
  updateStatus: UpdateCheckerStatus;
  onDismissUpdate: () => void;
  onReload: () => void;
}
```

#### `WaveformEditorDialog.tsx`（~70 行）

提取内容：波形编辑 `<Dialog>` 块（名称/说明 Input + Textarea + 保存/取消按钮）

Props 接口：

```ts
interface WaveformEditorDialogProps {
  editingWaveform: EditingWaveform | null;
  onEditingWaveformChange: (wf: EditingWaveform | null) => void;
  onSave: () => Promise<void>;
}
```

#### `ResetSettingsDialog.tsx`（~40 行）

提取内容：恢复默认设置确认 `<Dialog>`

Props 接口：

```ts
interface ResetSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}
```

### 结果

`App.tsx` 拆分后约 **600 行**，包含：全部 hook 调用、生命周期 effect、业务逻辑函数（`connect`、`send`、`stop`、`createNewSession` 等）、主布局 JSX 骨架。

---

## 第二项：`providers-openai-http/index.ts` 拆分

### 问题

697 行，Chat API 路径、Responses API 路径、序列化、JSON schema 操作、JSON 修复全部混在同一文件，难以定位和测试具体逻辑。

### 方案

拆为 `packages/providers-openai-http/src/` 下 4 个文件：

| 文件               | 内容                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `index.ts`         | `OpenAiHttpLlmClient` 主类 + 对外 export，约 250 行                                          |
| `serialization.ts` | `toChatMessages`, `toResponsesInput`, `toChatTool`, `toResponsesTool`, `toConversationItems` |
| `schema-utils.ts`  | `strictify`, `widenWithNull` 及 JSON Schema 相关操作                                         |
| `repair-json.ts`   | `repairJson` 独立模块，可被单独测试                                                          |

`index.ts` 从其他三个文件 import，对外 export 接口不变，调用方无感知。

---

## 第三项：`agent-runtime.ts` helper 提取

### 问题

`AgentRuntime` 类（约 550 行）之后跟着约 190 行纯函数工具，放在同一文件导致职责不清，且这些函数可独立测试。

### 方案

新建 `packages/runtime/src/session-history.ts`，迁移以下函数：

- `normalizeSessionHistory`
- `findPreviousComparableMessage`
- `appendAssistantMessage`
- `areAssistantMessagesEquivalent`
- `buildAssistantMessageSignature`
- `appendSkippedToolOutputs`
- `isInternalSyntheticMessage`

保留在 `agent-runtime.ts` 的：

- `createIncomingMessage`（与 `SendUserMessageInput` 类型强耦合）
- `buildTimerTriggerPrompt`（与 timer trigger 逻辑强耦合）
- `normalizeAssistantErrorMessage`
- `mergeBridgeOriginMetadata`

`agent-runtime.ts` 从 `session-history.ts` import，行为不变。

---

## 第四项：`permissions-browser` 补测试

### 测试文件

`packages/permissions-browser/src/index.test.ts`

### 覆盖场景

1. `allow-all` 模式：任何请求直接返回 `approve-once`，不调用 `requestFn`
2. timed 模式：窗口期内第二次请求复用已有 grant（不弹窗）
3. timed 模式：窗口期过期后重新进入询问流程
4. per-tool grant cache：`approve-scoped` 决定被缓存，同 tool 第二次请求不弹窗
5. per-tool grant cache：有限期 grant 过期后重新询问
6. `deny` 决定：返回中文说明，不缓存
7. `clearGrants()` 清除所有缓存

---

## 第五项：`build-browser-instructions` 补测试

### 测试文件

`apps/web/src/composition/build-browser-instructions.test.ts`

### 覆盖场景

1. 首次迭代（`isFirstIteration: true`）：输出包含 `[本回合策略]` 块
2. 后续迭代（`isFirstIteration: false`）：输出包含 `[后续迭代提醒]` 块，不含 `[本回合策略]`
3. `system` 来源（`sourceType: 'system'`）：输出包含 `[系统触发说明]` 块
4. 工具调用清单为空时：包含"(无)"和防假称提示
5. 工具调用清单非空时：包含调用列表和核查提示
6. 设备状态块：正确显示 `effectiveCapA = min(limitA, maxStrengthA)`

---

## 第六项：`prompts-basic` 补测试

### 测试文件

`packages/prompts-basic/src/index.test.ts`

### 覆盖场景

1. `BUILTIN_PROMPT_PRESETS` 数组非空，每个 preset 有 `id`、`name`、`prompt` 字段且均为非空字符串
2. `getBuiltinPromptPresetById` 能按 id 正确返回 preset
3. `getBuiltinPromptPresetById` 对未知 id 返回 `undefined`
4. 所有内置 preset 的 `id` 唯一

---

## 约束

- 所有重构只移动代码，不修改行为、不改 CSS 类名、不改任何 UI 交互
- `CLAUDE.md` 中标注的 UI 行为（布局间距、ChatPanel 标题栏、浮动输入区等）保持不变
- 每项独立可提交，不相互阻塞
- 测试使用现有测试框架（vitest）和现有 testkit 工具
