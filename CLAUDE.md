# CLAUDE.md

Guidance for Claude Code working in **DG-Agent** — the browser AI controller for DG-Lab Coyote 2.0 / 3.0.

## Project Overview

DG-Agent is a React 18 SPA that lets users chat with an LLM in natural language; the LLM calls device tools (`start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave` / `timer`) which the runtime translates into BLE writes via Web Bluetooth. Bundled with Vite, deployed to GitHub Pages.

The repo is a **monorepo** using npm workspaces, organized in a contract/adapter pattern. All shared code (BLE protocol, waveforms, tool definitions) is consumed from [`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) — DG-Agent's own packages are thin shims plus the React UI / runtime / bridge / providers / browser-only adapters.

## Repo Layout

```
apps/
  web/                      React 18 SPA shell
packages/
  agent-browser/            browser-side dependency wiring (no React deps)
  client/                   AgentClient abstraction (embedded / HTTP)
  runtime/                  agent loop, policy engine, tool executor, turn state
  bridge/                   QQ (OneBot/NapCat) + Telegram adapters
  device-webbluetooth/      shim re-exporting @dg-kit/protocol + @dg-kit/transport-webbluetooth
  permissions-browser/      timed permission grants + UI prompt
  providers-catalog/        provider registry (free proxy, Qwen, DeepSeek, etc.)
  providers-openai-http/    OpenAI-compatible transport
  storage-browser/          IndexedDB sessions + localStorage settings
  audio-browser/            DashScope ASR/TTS + native SpeechRecognition
  waveforms/                IndexedDB-backed library; basic/design/.pulse from @dg-kit/waveforms
  core/                     re-export of @dg-kit/core + agent-only contracts (LlmClient, SessionStore, …)
aliyun-fc/                  serverless free proxy (CommonJS, separate)
```

## Branch & PR Convention

- `dev` — day-to-day development. **All PRs target `dev`**, never `main` directly.
- `main` — releases only.
- After merging into `dev`, a CI mirror pushes the dev tip to [`0xNullAI/DG-Agent-dev`](https://github.com/0xNullAI/DG-Agent-dev) `main` (`git push dev-repo dev:main`). Use that mirror for read-only browsing.

## Commands

```bash
npm install
npm run dev          # Vite, apps/web
npm run build        # typecheck + Vite build for all workspaces
npm run typecheck    # tsc --noEmit across all packages
npm run test         # vitest run across all workspaces
npm run lint         # eslint, zero warnings
npm run lint:fix
npm run format
npm run format:check
```

## Test & Commit Workflow

Before every commit (covered by `lint-staged` on staged files, but verify the full repo):

1. `npm run lint` — zero warnings policy
2. `npm run typecheck`
3. `npm run test` — currently 74 tests
4. `npm run build`

Commit message style — conventional commits:

```
type(scope): short imperative subject

Optional body explaining the WHY. Wraps at 72 chars.
```

`type` ∈ `feat | fix | refactor | docs | chore | test | perf | style`. `scope` is usually a package name (`runtime`, `web`, `bridge`, …) or a cross-cutting concern.

PR description template:

```
## Summary
1-2 sentences: what changed and why.

## Test plan
- [x] npm run typecheck
- [x] npm run test
- [x] npm run lint
- [ ] Smoke test in browser (where applicable)
```

Squash-merge into `dev`. The squashed commit subject becomes the visible history.

## Architecture Notes

### Core Data Flow

```
apps/web (React UI)
  → @dg-agent/agent-browser (createBrowserServices factory)
    → AgentClient (embedded) → Runtime
      → DeviceClient / LlmClient / PermissionService
```

The runtime's `runTurn()` loops: build instructions → call LLM → if tool calls, execute them (with permission gate + per-turn caps) → loop until text-only reply.

### Key Patterns

- **UI / Agent separation**: `apps/web` is a pure React shell. All browser-side agent composition lives in `@dg-agent/agent-browser`'s `createBrowserServices()` factory (plain TS, no React). `apps/web` only wraps it with React lifecycle (useMemo) and UI-only services (theme, safety guard, update checker).
- **Contract/Adapter**: `@dg-agent/core` re-exports `@dg-kit/core` and adds agent-only contracts. Concrete implementations live in adapter packages.
- **Per-channel burst quota**: tracked per channel (A/B), not globally.
- **Policy engine**: hard-coded safety caps the LLM cannot bypass (max iterations, strength limits, cold-start clamp).
- **Model context strategy**: `last-user-turn` / `last-five-user-turns` / `full-history`.

### Package Naming

Mixed by design — read the rule before adding a new package:

- **No suffix** (`waveforms`, `bridge`): runtime-agnostic core (Node-friendly) alongside a browser adapter, both in the same package. Top-level module load must stay free of DOM / IndexedDB references so Node consumers can import without exploding.
- **`-browser` / `-webbluetooth` suffix**: pure browser-runtime implementation. Future Node.js alternatives ship as separate packages (`storage-node`, `permissions-node`, `device-serial`, `agent-node`, etc.).
- **`-http` / `-catalog` suffix**: describes a transport or role rather than a runtime; reusable across runtimes.

When adding a new package, pick the suffix matching its category. Do not introduce a third style.

### Strings & i18n

UI strings and error messages are in **Chinese (Simplified)**. The `aliyun-fc/` directory is a standalone CommonJS serverless function — not part of the TypeScript monorepo.

## UI Maintenance Notes

These behaviors have been confirmed by the user — do not change without explicit request.

### Layout

- Sidebar spacing (expand/collapse button, new session, session entries, settings) — do not tweak
- Send button must stay below the input box, not inline right
- Input area is a floating layer at the bottom, not a normal block
- Empty session shows only "欢迎使用 DG-Agent ！" — no example prompts

### ChatPanel

- Title bar must always be visible (not scrollable)
- Device status bar sits below the title bar, fully hidden when disconnected
- Input area is floating; must not drift upward when few messages

### Settings

- Settings save on drawer close, not on input blur or debounce
- Model context strategy, bridge config, voice config all follow the same rule

### Device & Bluetooth

- Bluetooth chooser only appears on explicit user click — never auto-triggered by messages or AI tool calls
- Session switch does not disconnect the device
- New/switch session clears permission grant cache

### Toasts

- Don't duplicate errors already shown in chat bubbles
- Timer-related system messages go in chat area, not toast
- No small colored pills above the input box

### Bridge

- Bridge messages route to the active session, auto-creating one if needed
- Bridge source persisted in session metadata for reply routing
- QQ/NapCat token passed via WebSocket URL query param `access_token`

See `docs/architecture.md` for full architecture decisions and guardrails.

## Sister Projects

| Project                                        | Purpose                                              |
| ---------------------------------------------- | ---------------------------------------------------- |
| [DG-Kit](https://github.com/0xNullAI/DG-Kit)   | Shared TypeScript runtime (consumed by this project) |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room with remote-control              |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP)   | MCP server for Claude Desktop                        |

## Code Conventions

- TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`
- ESM only (`"type": "module"`)
- `import type` for type-only imports
- Unused vars must be prefixed `_`
- No emojis in code or comments unless explicitly requested
- Comments explain WHY, not WHAT
