# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

转发狗 - 跨平台消息转发工具，支持 Discord、Telegram、飞书、X (Twitter)、Truth Social 之间的消息转发，具备多账号管理、关键词过滤、OCR 图片识别、自动翻译等功能。

## 常用命令

### 开发

```bash
# 安装依赖
pnpm install

# 启动 Next.js 管理界面（端口 3000）
pnpm dev          # 或 pnpm frontend

# 编译后端 Bot
pnpm build:bot

# 启动后端 Bot（需先编译）
pnpm start:bot

# 一键启动所有后端服务（自动编译 Bot + OCR 服务器 + Bot）
pnpm backend

# 测试 OCR 服务
pnpm test:ocr

# 启动 OCR 服务器（独立运行）
pnpm start:paddle-ocr-server
```

### 生产部署

```bash
# 构建并启动前端
pnpm build && pnpm start

# 启动后端
pnpm build:bot && pnpm start:bot
```

### Python Bridge 开发

```bash
# Telegram Bridge（需要 Python 3.8+）
cd telegram_bridge && pip install -e . && python -m telegram_bridge

# Discord Bridge
cd discord_bridge && pip install -e . && python -m discord_bridge
```

## 架构概览

### 双进程架构

项目分为两个独立运行的部分：

1. **Next.js 管理界面** (`app/`, `public/`)
   - 提供 Web UI 配置界面
   - API Routes 处理配置读写、账号管理、Telegram/Discord 登录流程
   - 端口 3000

2. **Node.js Bot 后端** (`src/`, `dist-bot/`)
   - 核心转发逻辑，完全独立运行
   - 通过 `config.json` 与前端共享配置
   - 自动管理 Telegram Bridge 和 Discord Bridge 子进程
   - 通过 `.data/` 目录与前端进行状态同步

### 核心模块 (src/)

| 文件 | 职责 |
|------|------|
| `index.ts` | 主入口，账号生命周期管理，配置热重载，共享客户端管理 |
| `bot.ts` | Discord 消息处理核心，过滤逻辑，转发路由 |
| `config.ts` | 配置类型定义，多账号配置解析 |
| `senderBot.ts` | Discord Webhook 发送器，翻译集成 |
| `feishuSender.ts` | 飞书消息发送器 |
| `telegramBridgeClient.ts` | Telegram Bridge IPC 客户端 |
| `discordBridgeClient.ts` | Discord Bridge IPC 客户端 |
| `processManager.ts` | Telegram/Discord Bridge 进程管理 |
| `externalForwarder.ts` | X/Truth Social 等外部平台转发器 |
| `connectionPool.ts` | 连接池管理 |
| `keywordMatcher.ts` | 关键词匹配与过滤 |
| `languageFilter.ts` | 语言检测与过滤 |
| `ocrClient.ts` | OCR 服务客户端 |
| `watermark.ts` | 图片水印处理 |

### Python Bridge 服务

**Telegram Bridge** (`telegram_bridge/`)
- Python 实现的 Telegram 客户端桥接服务
- 通过 stdio JSON-RPC 与 Node.js 通信
- 支持 Bot Token 和 User Client 两种模式
- 依赖：Telethon, rapidocr-onnxruntime

**Discord Bridge** (`discord_bridge/`)
- Python 实现的 Discord 客户端桥接服务
- 用于 selfbot 登录等特殊场景

### 转发类型

- `discord-to-discord`: Discord 频道间转发
- `discord-to-telegram`: Discord → Telegram
- `telegram-to-discord`: Telegram → Discord
- `telegram-to-telegram`: Telegram 频道间转发
- `discord-to-feishu`: Discord → 飞书
- `discord-to-dingtalk`: Discord → 钉钉
- `x-to-discord`: X (Twitter) → Discord
- `truthsocial-to-discord`: Truth Social → Discord

## 配置文件

- `config.json`: 运行时配置（由 UI 生成，勿手动编辑）
- `config.sample.json`: 配置示例
- `.env`: 环境变量（可选，如 `ENABLED_FORWARDING_TYPES`）
- `.data/`: 运行时状态目录（status.json、登录请求/响应文件）

## 关键数据流

```
消息源 → Bot.processAndSend() → 过滤检查 → 目标发送器
                                    ↓
                         关键词/用户/语言/OCR 过滤
```

## 进程间通信

- **前端 ↔ 后端**: 通过 `config.json` 共享配置，`.data/` 目录交换状态
- **Node.js ↔ Python Bridge**: stdio JSON-RPC 协议
- **配置热重载**: Bot 监听 `config.json` 变更自动重载

## 注意事项

- Discord selfbot 连接由 Discord Bridge (Python) 处理，Bot 类型使用 `discord.js`
- Telegram Bridge 需要 Python 3.8+ 环境
- 配置变更会触发热重载，无需重启 Bot
- OCR 服务器运行在端口 9003
