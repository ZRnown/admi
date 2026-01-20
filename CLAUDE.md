# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Discord 消息转发工具，支持多账号、多频道映射、关键词过滤、OCR 图片检测、自动翻译等功能。

## 核心架构

### 双模式运行

1. **Bot 后端**（必需）：完全独立的 Discord 消息转发服务
   - 位置：`src/` 目录
   - 编译输出：`dist-bot/`
   - 入口：`src/index.ts`

2. **管理界面**（可选）：Next.js Web 界面用于可视化配置
   - 位置：`app/` 目录
   - API 路由：`app/api/`

### 关键模块职责

- `src/index.ts` - 多账号管理器，负责启动/停止账号、配置热重载、状态持久化
- `src/bot.ts` - Discord 消息监听和处理核心逻辑
- `src/senderBot.ts` - Webhook 消息发送器，支持翻译、中转机器人
- `src/feishuSender.ts` - 飞书消息发送器
- `src/ocrClient.ts` - OCR 图片检测客户端
- `src/config.ts` - 配置管理，支持单账号和多账号配置

### 多账号架构

每个账号独立运行：
- 独立的 Discord Client（支持 bot 和 selfbot 两种类型）
- 独立的 Bot 实例处理消息
- 独立的 SenderBot 实例（按源频道映射）
- 独立的 FeishuSender 实例（如果启用飞书转发）
- 支持独立的代理配置

## 常用命令

### Bot 开发和运行

```bash
# 编译 Bot
pnpm build:bot

# 运行 Bot
pnpm start:bot
```

### 管理界面开发

```bash
# 开发模式（热重载）
pnpm dev

# 生产构建和运行
pnpm build
pnpm start
```

### OCR 服务

```bash
# 轻量级 OCR（Tesseract，端口 9004）
pnpm start:simple-ocr-server

# 高精度 OCR（RapidOCR，端口 9003）
pnpm start:paddle-ocr-server
```

## 配置文件

### config.json

主配置文件，支持两种格式：

1. **多账号格式**（推荐）：
```json
{
  "accounts": [
    {
      "id": "account1",
      "name": "主账号",
      "type": "selfbot",
      "token": "...",
      "proxyUrl": "http://proxy:port",
      "channelWebhooks": {
        "sourceChannelId": "webhookUrl"
      },
      "enableTranslation": true,
      "ocrServerUrl": "http://localhost:9003"
    }
  ]
}
```

2. **单账号格式**（向后兼容）：直接在根对象配置，会自动转换为多账号格式

### 配置热重载

Bot 会监听 `config.json` 文件变化，自动重新加载配置并重启受影响的账号。使用文件 hash 避免重复加载。

## 部署

### 生产环境部署

使用 PM2 管理进程（推荐）：

```bash
# 启动 Bot
pm2 start dist-bot/index.js --name "discord-bot"

# 启动 OCR 服务（可选）
pm2 start simple_ocr_server.js --name "ocr-server"

# 保存配置并设置开机自启
pm2 save
pm2 startup
```

详细部署指南参见 `DEPLOY.md`。

### OCR 服务部署

两种方案：
1. **轻量级**：Tesseract OCR（端口 9004）- 简单但准确率一般
2. **高精度**：RapidOCR（端口 9003）- 准确率高，需要更多依赖

快速修复脚本：
- `./quick_fix_ocr.sh` - 安装轻量级 OCR
- `./fix_rapidocr_headless.sh` - 修复 RapidOCR 无头环境问题

## 重要实现细节

### 消息转发流程

1. Bot 监听 Discord 消息事件（`messageCreate`）
2. 检查消息是否符合转发条件（频道白名单/黑名单、关键词过滤等）
3. 如果启用 OCR，下载图片并检测违规关键词
4. 如果启用翻译，调用翻译 API
5. 通过 SenderBot 发送到目标 Webhook
6. 如果启用飞书转发，同时发送到飞书

### 中转机器人（Bot Relay）

支持通过中转机器人发送消息（而非直接使用 Webhook）：
- 配置 `enableBotRelay: true` 和 `botRelayToken`
- 支持多个中转机器人，通过 `channelRelayMap` 映射源频道到中转机器人
- 中转机器人需要单独运行（使用 `senderBot.ts` 的 Webhook 模式）

### 状态持久化

Bot 运行状态保存在 `.data/status.json`，包含每个账号的登录状态和错误信息，供管理界面展示。

## TypeScript 配置

- `tsconfig.bot.json` - Bot 编译配置（输出到 `dist-bot/`）
- `tsconfig.json` - Next.js 配置（默认）

编译 Bot 时使用：`tsc -p tsconfig.bot.json`
