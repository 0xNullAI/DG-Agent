# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

DG-Agent is a browser-based AI controller for DG-Lab Coyote (2.0 & 3.0) pulse devices. Users chat with an AI in natural language, and the AI controls the device via Web Bluetooth. The app is a React 18 SPA built with Vite and deployed to GitHub Pages.

The codebase is a **monorepo** using npm workspaces with a port/adapter architecture.

## Commands

- `npm run dev` — Start local dev server (Vite, apps/web)
- `npm run build` — Build all workspaces (type-check + vite build)
- `npm run typecheck` — Type-check all workspaces
- `npm run test` — Run tests across all workspaces
- Self-tests: `node packages/<name>/dist/self-test.js` (bridge-core, providers-catalog, runtime, storage-browser)

- `npm run lint` — ESLint with zero warnings allowed
- `npm run lint:fix` — Auto-fix lint issues
- `npm run format` — Format with Prettier
- `npm run format:check` — Check formatting

## Architecture

### Monorepo Structure

```
apps/web/          — React 18 SPA (shadcn/ui + Tailwind CSS v4)
packages/
  core/            — Shared types (DeviceState, SessionSnapshot, etc.)
  contracts/       — Port interfaces (DevicePort, LlmPort, PermissionPort, etc.)
  api-contracts/   — REST route definitions and request/response types
  client/          — AgentClient abstraction (embedded or HTTP)
  runtime/         — Agent loop, policy engine, tool executor, turn state
  device-webbluetooth/ — Web Bluetooth adapter for Coyote v2/v3
  providers-catalog/   — Provider registry (free proxy, Qwen, DeepSeek, etc.)
  providers-openai-http/ — OpenAI-compatible HTTP/SSE transport
  bridge-core/     — Bridge manager, message queue, permission port
  bridge-browser/  — QQ (OneBot/NapCat) and Telegram adapters
  permissions-basic/   — Basic permission gate
  permissions-browser/ — Browser permission gate with timed grants
  prompts-basic/   — System prompt builder
  audio-browser/   — DashScope ASR/TTS proxy
  safety-browser/  — Visibility/leave safety guard
  storage-browser/ — IndexedDB session store + localStorage settings
  theme-browser/   — Theme application (dark/light/auto)
  update-browser/  — Version update checker
  waveforms-basic/ — Built-in waveform definitions
  waveforms-browser/ — Waveform library with import/export
  testkit/         — Fake device, LLM, permission for testing
aliyun-fc/         — Aliyun FC serverless free proxy (CommonJS, separate)
```

### Core Data Flow

```
Web UI → AgentClient(embedded) → Runtime → DevicePort / LlmPort / PermissionPort
```

The runtime's `runTurn()` loops: build instructions → call LLM → if tool calls, execute them (with permission gate + per-turn caps) → loop until text-only reply.

### Key Patterns

- **Port/Adapter**: `@dg-agent/contracts` defines interfaces, implementations in `*-browser` / `*-basic` packages.
- **Per-channel burst quota**: Burst calls are tracked per channel (A/B), not globally.
- **Policy engine**: Hard-coded safety caps the LLM cannot bypass (max iterations, strength limits, cold-start clamp).
- **Model context strategy**: `last-user-turn` / `last-five-user-turns` / `full-history`.

## Development Conventions

- Branch model: develop on `dev` or feature branches, PRs to `dev`. `main` is for releases only.
- UI strings and error messages are in Chinese (Simplified).
- The `aliyun-fc/` directory is a standalone CommonJS serverless function — not part of the TypeScript monorepo.
- All packages use `"type": "module"` with TypeScript project references.
- Use `import type` for type-only imports.
- Unused vars must use `_` prefix pattern.

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
