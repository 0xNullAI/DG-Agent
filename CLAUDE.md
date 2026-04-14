# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DG-Agent is a browser-based AI controller for DG-Lab Coyote (2.0 & 3.0) pulse devices. Users chat with an AI in natural language, and the AI controls the device via Web Bluetooth. The app is a vanilla TypeScript SPA (no framework) built with Vite, deployed to GitHub Pages.

## Commands

- `npm run dev` — Start local dev server (Vite)
- `npm run build` — Type-check (`tsc`) then build (`vite build`)
- `npm run lint` — ESLint with zero warnings allowed
- `npm run lint:fix` — Auto-fix lint issues
- `npm run format` — Format with Prettier
- `npm run format:check` — Check formatting

No test framework is configured.

## Architecture

### Module Layers

The codebase has two main layers with a clear boundary:

- **`src/agent/`** — Pure logic layer (no DOM). Handles AI conversation, BLE protocol, tool execution, and safety policies.
- **`src/ui/`** — DOM/rendering layer. Calls into agent via the barrel export at `agent/index.ts`.

The barrel (`agent/index.ts`) intentionally re-exports only what the UI needs. Deeper modules (runner, transport, policies, tools, prompts) are imported directly by agent-internal code.

### Agent Loop (`runner.ts` → `transport.ts`)

A single user message triggers `runTurn()` which loops:

1. Build system instructions (with device state + prior tool calls this turn)
2. Call LLM via `callResponses()` (supports both Responses API and Chat Completions API)
3. If the model emits tool calls → execute them (with permission gate + per-turn caps) → loop
4. If the model emits only text → return as final reply

The runner enforces hard caps from `policies.ts` (max iterations, max tool calls, per-tool limits). These are code-level safety rails the LLM cannot bypass.

### Tool System (`tools.ts`)

Six tools: `start`, `stop`, `adjust_strength`, `change_wave`, `burst`, `timer`. Tool schemas are rebuilt each call (waveform enum is dynamic from user library). Handlers are static in `HANDLERS` map. All strength values are clamped against device limits and user-configured max.

### Transport (`transport.ts`)

Provider-agnostic HTTP/SSE layer. Routes to either `/responses` (Responses API) or `/chat/completions` depending on provider. Handles strict-mode schema transformation (`strictify`) for OpenAI-compatible backends. Providers: free proxy, Qwen, DeepSeek, Doubao, OpenAI, custom.

### Bluetooth (`bluetooth.ts`)

Web Bluetooth module supporting both Coyote 2.0 and 3.0 hardware. Handles BLE characteristic discovery, wave frame encoding, and strength control. Device name prefixes: `47L121` (v3), `D-LAB ESTIM` (v2).

### Bridge (`bridge/`)

Optional social platform bridge (QQ via WebSocket, Telegram via bot API). Routes incoming messages through the same conversation pipeline. Has its own permission system (`permission-bridge.ts`). All runs in-browser.

### Persistence

All state is in `localStorage` — settings (`dg-agent-settings`), conversation history, saved prompts. No backend database.

## Development Conventions

- Branch model: develop on `dev`, PRs to `dev`. `main` is for releases only.
- ESLint enforces `consistent-type-imports` (use `import type` for type-only imports).
- Unused vars must use `_` prefix pattern.
- `__BUILD_ID__` is a Vite-injected global (declared readonly in ESLint config).
- The `aliyun-fc/` directory contains a CommonJS serverless function (free proxy) — separate from the main TypeScript app.
- UI strings and error messages are in Chinese (Simplified).
