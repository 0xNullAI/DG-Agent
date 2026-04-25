# 包结构重组设计

日期：2026-04-25
状态：已实施

## 背景与问题

重构前 monorepo 有 21 个 packages。其中多个包属于「contract/adapter 模式被过度套用到不够大的模块」：

- `permissions-basic`（22 行）、`safety-browser`（45 行）、`theme-browser`（53 行）、
  `api-contracts`（37 行）等几个包体量极小，独立成包带来的 `package.json` /
  `tsconfig.json` / 构建依赖链维护成本远大于收益。
- `core`（283 行）+ `contracts`（96 行）几乎总是一起 import，分裂没有实际意义。
- `apps/web` 里 `composition/` 目录承担了「浏览器端 Agent 组装」职责，
  但又混合了 React Hook 生命周期管理，UI 层与 Agent 层边界不清晰。

## 目标

1. **消除碎片化**：合并/内嵌没有独立存在价值的小包。
2. **建立清晰的 UI / Agent 边界**：把浏览器端 Agent 组装逻辑抽到独立包，
   `apps/web` 退化为纯 React UI 壳。
3. **保留 contract/adapter 分层**：为后续 Node.js 服务端版本铺路 —
   核心包（core / runtime / client）和适配器包（device-_ / providers-_ /
   bridge / permissions / waveforms）的分层不能因合并而模糊。
4. **维持现有功能行为不变**：所有合并/迁移操作不引入语义变化。

## 方案：方案 B（清理 + UI/Agent 分层）

从 21 个包减少到 13 个包，并新增 `agent-browser`。

### 包变化

**合并：**

- `contracts` → `core`（统一类型 + 接口）
- `permissions-basic` + `permissions-browser` → `permissions`
- `waveforms-basic` + `waveforms-browser` → `waveforms`
- `bridge-core` + `bridge-browser` → `bridge`

**内嵌：**

- `prompts-basic` → `runtime/src/prompts/`
- `api-contracts` → `client/src/api-routes.ts`

**下沉到 apps/web：**

- `theme-browser` → `apps/web/src/services/theme.ts`
- `safety-browser` → `apps/web/src/services/safety-guard.ts`
- `update-browser` → `apps/web/src/services/update-checker.ts`

**新增：**

- `agent-browser`：浏览器端 Agent 组装层。包含
  `createBrowserAgentClient`、`createBuildBrowserInstructions`、新的
  `createBrowserServices()` 工厂函数。无 React 依赖。

### 最终包列表（13 个）

```
core / runtime / client / agent-browser /
device-webbluetooth / providers-openai-http / providers-catalog /
bridge / permissions / waveforms /
storage-browser / audio-browser / testkit
```

### UI / Agent 分层

```
apps/web (React UI)
  └── apps/web/src/composition/use-browser-app-services.ts
       (薄壳 React Hook：useMemo + setPendingPermission 包装)
       │
       ▼
  packages/agent-browser
       └── createBrowserServices(opts: BrowserServicesOptions)
              opts.onPermissionRequest = (input) => Promise<PermissionDecision>
              opts.resolveBridgeSessionId = ...
            返回 { client, device, bridgeManager, waveformLibrary,
                  speech*, modes, resetPermissionGrants, warnings }
       │
       ▼
  其他 packages（client / runtime / device / bridge / ...）
```

`createBrowserServices` 是纯 TS 工厂，接收回调而非 React state setter。
React 生命周期管理（useMemo 依赖跟踪、setState 包装）只在 `apps/web` 的 hook 里。

## 决策记录

### Q：要不要保留 bridge-core + bridge-browser 的拆分？

**结论：合并。**

虽然将来要做 Node.js 端 `bridge-node`，但合并后的 `bridge` 包内部已经把
浏览器适配器隔离在 `adapters.ts` 里。Node 端引入时通过 tree-shaking 即可
避免拖入浏览器代码（`bridge-browser` 原本也只有 486 行 WebSocket
adapter 代码）。如果将来浏览器代码膨胀，可以再次拆出 `bridge-browser`。

验证：合并后 `bridge/src/` 没有任何顶层 `window`/`document`/`indexedDB` 引用。

### Q：permissions / waveforms 合并是否会污染 Node.js 端？

**结论：合并。**

这两个包的 `browser` 实现都把 DOM/IndexedDB 调用收敛在方法内部，没有顶层副作用。
Node.js 端 import 同一个包时，只要不实例化 `BrowserPermissionService` /
`BrowserWaveformLibrary`，就不会触发任何浏览器 API。

验证：`grep` 确认 `permissions/src/`、`waveforms/src/` 没有顶层 DOM 引用。
`permissions/src/browser.ts` 中的 `window.confirm` 调用在方法内部，且有
`typeof window === 'undefined'` 守卫。

### Q：浏览器小工具（theme/safety/update）放哪里？

**结论：下沉到 `apps/web/src/services/`，不再是独立包。**

这三个包合计约 200 行，全部是 UI / 浏览器生命周期工具，永远不会被
其他 package 复用。维持独立包没有任何收益，反而拉高维护成本。

### Q：agent-browser 是否会成为 god package？

**结论：可接受。**

agent-browser 是 composition root，依赖几乎所有 browser 适配器是它的
固有职责。它没有自己的业务逻辑，只负责把适配器拼装成 `BrowserServices`。
将来 `agent-node` 也会以同样的方式存在。

## 实施阶段

每个 Stage 独立 commit，便于回滚。每个 Stage 完成后运行
`npm run typecheck && npm run test && npm run lint`。

1. **Stage 1**：合并 `contracts` → `core`
2. **Stage 2**：合并 `permissions`、`waveforms`、`bridge`（三对 basic+browser）
3. **Stage 3**：内嵌 `prompts-basic` → `runtime`、`api-contracts` → `client`
4. **Stage 4**：浏览器小工具（theme/safety/update）下沉到 `apps/web/src/services/`
5. **Stage 5**：新建 `packages/agent-browser`，迁移 composition 层
6. **Stage 6**：同步 `CLAUDE.md` 和 `docs/architecture.md`，写本设计 spec

## 验收标准

- [x] `npm run typecheck` 通过
- [x] `npm run test` 全过（runtime self-test、storage-browser self-test、
      apps/web vitest）
- [x] `npm run lint` 零警告
- [x] `npm run build` 成功
- [x] `CLAUDE.md` 与 `docs/architecture.md` 与新结构一致

## 后续工作（非本次范围）

- `runtime.test.ts` 中存在 5 个预先失败的 vitest 用例（与 streaming text
  feature 相关），未在本次重构范围内。runtime 的 `npm test` 脚本目前
  仍只跑 `tsx self-test.ts`，没有把 vitest 接入，避免暴露这些预存在的失败。
- 命名风格不完全统一：合并后部分包去掉了 `-basic`/`-browser` 后缀
  （permissions / waveforms / bridge），但 `storage-browser`、
  `audio-browser`、`device-webbluetooth`、`agent-browser` 仍保留后缀。
  这是因为这些包是"纯浏览器"实现，没有 basic 对应物；将来有 Node 端
  实现时再考虑是否拆出 `*-core`。
- 未来 Node.js 服务端版本：新增 `agent-node`、`device-*-node`、
  `storage-node`、`bridge-node` 等适配器包，复用现有的 `core` /
  `runtime` / `client` / `providers-*`。
