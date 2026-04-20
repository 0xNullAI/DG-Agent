# DG-Agent — 在浏览器中用 AI 控制郊狼

> 基于 Web Bluetooth 的 DG-Lab 郊狼 脉冲主机 AI 控制器，打开网页即可通过自然语言对话控制设备。

> 交流 QQ 群：**628954471**

**[立即体验 → 0xnullai.github.io/DG-Agent](https://0xnullai.github.io/DG-Agent/)**

## 特性

- **全设备适配** — 手机、平板、电脑，响应式布局 + 深色/浅色主题
- **纯网页运行** — 无需安装任何 APP，打开浏览器即用
- **隐私安全** — 无后端服务器，API Key 和聊天数据仅存在你的设备上
- **BLE 直连** — Web Bluetooth 直接连接郊狼 2.0 / 3.0，无需手机 APP
- **自定义人设** — 自由编写 AI 人设提示词，支持保存多套方案
- **可管理的波形库** — 支持手动导入 `.pulse` 或 `.zip` 并在设置里编辑名称和说明
- **多层安全护栏** — 固定强度上限、单回合调用频次限制、AI 幻觉检测自动纠正
- **语音对话** — 支持语音输入 (ASR) 和语音回放 (TTS)，基于 DashScope
- **社交桥接** — 通过 QQ (NapCat/OneBot) 或 Telegram Bot 远程控制
- **上下文策略** — 可选截取到上一轮 / 前五轮 / 完整历史

## 快速开始

### 1. 选择 AI 服务并配置

点击顶栏 ⚙️ 按钮，选择一个 AI 服务商并填入 API Key：

| 服务商              | 国内直连  | 说明                                                                                               |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| **免费体验** (推荐) | ✅        | 无需 API Key，使用阿里云线路，每分钟限 10 条（模型由 [MapleLeaf API](https://ai.071129.xyz) 提供） |
| **通义千问**        | ✅        | [bailian.console.aliyun.com](https://bailian.console.aliyun.com)                                   |
| **DeepSeek**        | ✅        | [platform.deepseek.com](https://platform.deepseek.com)                                             |
| **豆包**            | ✅        | 火山方舟 [www.volcengine.com/product/ark](https://www.volcengine.com/product/ark)                  |
| **OpenAI**          | ❌ 需代理 | [platform.openai.com](https://platform.openai.com)                                                 |
| **自定义**          | —         | 自定义模型、API Key 和接口地址，兼容 OpenAI API 格式                                               |

### 2. 连接设备

1. 长按郊狼电源键开机
2. 确保设备蓝牙已开启
3. 点击顶栏蓝牙按钮，在弹出的系统配对框中选择设备

> ⚠️ Web Bluetooth 需要 HTTPS 环境 + 支持的浏览器（Chrome / Edge / Opera）

### 3. 开始对话

选择一个场景模式（或自定义人设），然后直接和 AI 聊天。AI 会根据对话内容自动控制设备：

```
你：轻轻试一下 A 通道
AI：好的，我先用很轻的力度让你感受一下~
    🔧 play(channel: A, strength: 8, preset: breath)
AI：已经开始了哦，是很轻柔的呼吸波形，感觉怎么样？
```

## 浏览器支持

| 浏览器           | 状态        | 说明                         |
| ---------------- | ----------- | ---------------------------- |
| Chrome (桌面)    | ✅ 支持     | 推荐                         |
| Edge (桌面)      | ✅ 支持     | 推荐                         |
| Chrome (Android) | ✅ 支持     | 需系统蓝牙权限               |
| Opera            | ⚠️ 部分支持 | 需手动启用 Web Bluetooth     |
| Safari           | ❌ 不支持   | Apple 未实现 Web Bluetooth   |
| Firefox          | ❌ 不支持   | Mozilla 未实现 Web Bluetooth |

## 安全须知

1. **从低强度开始** — 首次使用建议强度设为 `5~10`，逐步增加
2. **设置软上限** — 在 App 设置中调整 A/B 强度上限，所有 AI 操作都会被自动夹紧
3. **紧急停止** — 直接关闭郊狼电源即可立即停止所有输出
4. **禁止区域** — 请勿将电极放置在心脏区域或头颈部
5. **AI 不是人** — AI 无法感知你的实际体验，请随时手动调整或停止

## 本地开发

```bash
npm install
npm run dev
```

其他命令：

```bash
npm run build          # 构建所有工作空间
npm run typecheck      # 全量类型检查
npm run test           # 运行测试
npm run lint           # ESLint
npm run format:check   # Prettier 检查
```

项目是 npm workspaces monorepo，详细架构见 [docs/architecture.md](docs/architecture.md)。

## 贡献指南

- **报告 Bug / 提建议**：在 [Issues](https://github.com/0xNullAI/DG-Agent/issues) 里描述复现步骤、浏览器版本和设备型号。
- **提交代码**：请基于 `dev` 分支开发，PR 也请提交到 `dev`（`main` 只接收版本发布合并）。
- **提交信息**：建议使用简洁的英文祈使句（如 `Add DeepSeek provider`），单个 PR 聚焦一件事。
- **本地开发**：`npm install && npm run dev` 启动本地服务；改动涉及 UI 请在手机和桌面断点下都验证一遍。

## 致谢

- [DG-MCP](https://github.com/0xNullAI/DG-MCP) — 本项目的 Python MCP 版本
- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE) — 官方开源 BLE 协议
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab) — 波形解析器参考实现
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab) — Dungeonlab+pulse 波形解析引擎
- [MapleLeaf API](https://ai.071129.xyz) — 为"免费体验"模式提供模型调用

## 免责声明

> **本项目仅供学习交流使用，不得用于任何违法或不当用途。使用者应自行承担使用本项目所产生的一切风险和责任，项目作者不对因使用本项目而导致的任何直接或间接损害承担责任。**
