<div align="center">

# DG-Agent

**用自然语言控制 DG-Lab 郊狼 2.0 / 3.0**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/DG-Kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.github.io/DG-Agent/)

中文 | [English](./README.en.md)

> 交流 QQ 群：**628954471**

</div>

## 这是什么

DG-Agent 是一个浏览器版的 AI 设备控制器。打开网页、连上你的郊狼、跟 AI 对话——它会通过工具调用真实控制设备：调强度、换波形、设计新波形、定时跟进。

跟普通的 chatbot 不一样的地方在于：AI 真的能"动手"。"启动 A 通道，强度 5，用呼吸波形" 这句话会被理解为一个工具调用序列，AI 自己安全地拆步执行，每一步都受策略引擎约束。

## 特性

- **多 LLM 支持** — OpenAI / Anthropic / DeepSeek / Qwen / 任何 OpenAI 兼容服务，并内置免费体验模式
- **完整工具集** — `start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave` / `timer`
- **AI 设计波形** — 用 `ramp / hold / pulse / silence` 段落组合自定义波形，自动入库
- **语音输入输出** — 浏览器原生 ASR + 阿里云 DashScope ASR/TTS 二选一
- **社交桥接** — 通过 QQ（NapCat/OneBot）或 Telegram Bot，让群友也能用文字驱动你的设备
- **安全保障** — 强度上限、单回合调用次数上限、冷启动钳制、紧急停止
- **完全本地** — 会话、波形库、设置全部在浏览器（IndexedDB / localStorage）

## 快速开始

### 在线试玩

直接打开 [demo](https://0xnullai.github.io/DG-Agent/)。Web Bluetooth 需要 **Chrome 或 Edge**，HTTPS 已配好。

### 本地开发

```bash
git clone https://github.com/0xNullAI/DG-Agent.git
cd DG-Agent
npm install
npm run dev
```

打开 http://localhost:5173/ 即可。

## 使用方法

1. 打开页面，点设置（齿轮图标）→ 配置一个 LLM provider 和 API key
2. 长按郊狼电源键开机
3. 点顶部蓝牙按钮 → 系统弹窗里选你的设备
4. 在输入框跟 AI 说话："请用呼吸波形启动 A 通道，强度 5"
5. AI 会描述意图、执行、并询问感受。回话调整即可。

> 推荐第一次用先把强度上限调到 30 以下，等熟悉了再放开。

## 架构

```
apps/web/                  React 18 SPA UI 壳
packages/
  agent-browser/           浏览器侧依赖装配
  runtime/                 Agent 运行循环、策略引擎、turn state
  bridge/                  QQ / Telegram 桥
  device-webbluetooth/     DG-Kit 协议层的浏览器转接
  waveforms/               基于 IndexedDB 的浏览器波形库
  ...
```

[`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) 提供的部分：协议字节打包、波形编译、`.pulse` 解析、工具定义。本仓库聚焦在 React UI、会话管理、LLM 接入、桥接 IM 等浏览器/agent 专属功能。

## 分支约定

- `dev` — 日常开发分支，PR 全部走这里
- `main` — 仅用于发版本

## 命令

```bash
npm run dev          # 本地开发
npm run build        # 类型检查 + Vite 构建
npm run typecheck    # 仅类型检查
npm run test         # vitest
npm run lint         # eslint
npm run format       # prettier --write
```

## 致谢

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE) — 官方开源 BLE 协议
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab) — 波形解析器参考实现
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab) — Dungeonlab+pulse 波形解析引擎
- [MapleLeaf API](https://aihub.071129.xyz) — 为"免费体验"模式提供模型调用

## 相关项目

| 项目                                           | 用途                                       |
| ---------------------------------------------- | ------------------------------------------ |
| [DG-Kit](https://github.com/0xNullAI/DG-Kit)   | 共享的 TypeScript 中台（被本项目消费）     |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | 多人 P2P 房间，远程控制队友设备            |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP)   | MCP 服务器，让 Claude Desktop 直接驱动设备 |

## 免责声明

> **本项目仅供学习交流使用，不得用于任何违法或不当用途。使用者应自行承担使用本项目所产生的一切风险和责任，项目作者不对因使用本项目而导致的任何直接或间接损害承担责任。**

## 协议

[MIT](./LICENSE)
