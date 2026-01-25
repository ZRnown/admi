# 转发狗

Discord 消息转发工具，支持多账号、多频道映射、关键词过滤、自动翻译等功能。

## 🚀 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置

复制 `config.sample.json` 为 `config.json` 并编辑：

```bash
cp config.sample.json config.json
```

### 2.1 可选环境变量（.env）

`.env` 放在项目根目录（与 `package.json` 同级）。不配置则保持默认行为。

```bash
# 仅允许显示指定转发类型（留空或不设置则全部可用）
ENABLED_FORWARDING_TYPES=discord-to-discord,discord-to-telegram,telegram-to-discord,discord-to-feishu
```

管理界面“导入配置”会覆盖当前所有配置，导入后以导入内容为准。

### 3. 启动服务

#### 启动管理界面（可选）

```bash
# 开发模式
pnpm dev:server

# 或生产模式
pnpm build:server && pnpm start:server
```

访问 `http://localhost:3000` 进行可视化配置。

#### 启动后端 Bot（必需）

```bash
# 编译
pnpm build:bot

# 运行
pnpm start:bot
```

## 📁 项目结构

```
admi/
├── src/              # 后端 Bot 核心代码（完全独立）
│   ├── index.ts      # 主入口
│   ├── bot.ts        # Bot 逻辑
│   ├── senderBot.ts  # Webhook 发送器
│   └── ...
├── server.ts         # Express 管理界面服务器
├── public/           # 静态文件（HTML 管理界面）
├── config.json       # 配置文件（运行时生成）
└── dist-bot/         # 编译后的 Bot 代码
```

## 🔒 安全性

- ✅ **后端独立运行** - Bot 核心代码不依赖任何 Web 框架
- ✅ **轻量级架构** - Express + 纯 HTML，攻击面更小

## 🛠️ 开发

### 仅开发 Bot

```bash
pnpm build:bot
pnpm start:bot
```

### 开发管理界面

```bash
pnpm dev:server
```

## 📌 转发类型使用说明

### Discord → Discord

1. 选择转发类型为“Discord → Discord”。
2. 填写 Discord Token（自用号或机器人 Token）。
3. 在“转发规则”中填写来源频道/子区 ID 和目标 Webhook URL。
4. 需要伪装源用户时勾选“使用源用户昵称和头像”。

### Discord → Telegram

1. 选择转发类型为“Discord → Telegram”。
2. 填写 Discord Token 与 Telegram Bot Token。
3. 将 Bot 拉入目标 Telegram 群/频道并授予发消息权限。
4. 在“转发规则”中填写来源 Discord 频道/子区 ID 和目标 Telegram Chat ID。

### Telegram → Discord

1. 选择转发类型为“Telegram → Discord”。
2. 填写 Telegram API ID / API Hash，并完成 Session 认证（文件或字符串）。
3. 在“转发规则”中填写来源 Telegram Chat ID 或用户名（可用 @xxx 或 xxx），目标填 Discord Webhook URL。

### Discord → 飞书

1. 选择转发类型为“Discord → 飞书”。
2. 填写 Discord Token，并开启飞书转发。
3. 目标可用飞书 Webhook 或线程 ID（Thread）。
4. 需要转发图片/视频时填写飞书 App ID / Secret，并在飞书后台开通 `im:resource:upload` 与 `im:message:send_as_bot` 权限。

## 📄 许可证

私有项目
