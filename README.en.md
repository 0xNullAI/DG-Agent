<div align="center">

# DG-Agent

**Control your DG-Lab Coyote 2.0 / 3.0 with natural language**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/DG-Kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.github.io/DG-Agent/)

[中文](./README.md) | English

</div>

## What it is

DG-Agent is a browser-based AI device controller. Open the page, connect your Coyote, talk to the AI — it actually drives the device through tool calls: adjust strength, swap waveform, design a new waveform, schedule follow-ups.

Unlike a regular chatbot, DG-Agent really gets its hands dirty. "Start channel A at strength 5 with the breath waveform" gets parsed into a sequence of tool calls; the AI executes them step-by-step, every step constrained by a policy engine.

## Features

- **Multi-LLM** — OpenAI / Anthropic / DeepSeek / Qwen / any OpenAI-compatible endpoint, plus a free-trial proxy
- **Full toolset** — `start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave` / `timer`
- **AI-designed waveforms** — compose `ramp / hold / pulse / silence` segments into custom waveforms, auto-saved to the library
- **Voice in/out** — native browser ASR + Aliyun DashScope ASR/TTS
- **IM bridge** — QQ (NapCat/OneBot) or Telegram Bot, so chat-room friends can drive the device too
- **Safety** — strength caps, per-turn call limits, cold-start clamp, emergency stop
- **Fully local** — sessions, waveform library, and settings live in your browser (IndexedDB / localStorage)

## Quick start

### Try online

Open the [demo](https://0xnullai.github.io/DG-Agent/). Web Bluetooth requires **Chrome or Edge**; HTTPS is already configured.

### Local development

```bash
git clone https://github.com/0xNullAI/DG-Agent.git
cd DG-Agent
npm install
npm run dev
```

Visit http://localhost:5173/.

## Usage

1. Open the page, click the gear icon → set up an LLM provider and API key
2. Long-press the Coyote power button to turn it on
3. Click the Bluetooth icon at the top → pick your device in the system chooser
4. Talk to the AI: "Start channel A at strength 5 with the breath waveform"
5. The AI describes intent, executes, and asks how it feels. Iterate from there.

> First time? Set the strength cap below 30. Loosen it once you're comfortable.

## Architecture

```
apps/web/                  React 18 SPA shell
packages/
  agent-browser/           browser-side dependency wiring
  runtime/                 agent loop, policy engine, turn state
  bridge/                  QQ / Telegram bridge
  device-webbluetooth/     thin shim over @dg-kit/protocol for the browser
  waveforms/               IndexedDB-backed browser waveform library
  ...
```

What [`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) provides: protocol byte packing, waveform compiler, `.pulse` parser, tool definitions. This repo focuses on the React UI, session management, LLM clients, and the IM bridge.

## Branch convention

- `dev` — day-to-day development; all PRs target here
- `main` — release-only

## Scripts

```bash
npm run dev          # local dev
npm run build        # typecheck + Vite build
npm run typecheck
npm run test         # vitest
npm run lint
npm run format
```

## Acknowledgements

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE) — official BLE protocol
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab) — waveform parser reference
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab) — Dungeonlab+pulse parsing engine
- [MapleLeaf API](https://aihub.071129.xyz) — model proxy for the free-trial mode

## Sister projects

| Project                                        | Purpose                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| [DG-Kit](https://github.com/0xNullAI/DG-Kit)   | Shared TypeScript runtime (consumed by this project)          |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room with remote-control of teammates' devices |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP)   | MCP server, lets Claude Desktop drive the device              |

## Disclaimer

> **This project is for learning and research purposes only. It must not be used for any illegal or improper purpose. Users assume all risks; the authors accept no liability for any direct or indirect damages arising from use.**

## License

[MIT](./LICENSE)
