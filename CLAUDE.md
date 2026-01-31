# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Discord Forwarder (转发狗) - A message forwarding tool supporting multi-account management, multi-channel mapping, keyword filtering, auto-translation, and cross-platform forwarding.

**Supported forwarding types:**
- Discord → Discord
- Discord → Telegram
- Telegram → Discord
- Telegram → Telegram
- Discord → Feishu (飞书)
- X (Twitter) → Discord
- Truth Social → Discord

## Build and Run Commands

### Quick Start

```bash
pnpm install            # Install dependencies
pnpm backend            # Start backend (Bot + OCR + Telegram Bridge)
pnpm frontend           # Start frontend (Web Management UI on port 3000)
```

### Individual Commands

```bash
# Bot
pnpm build:bot          # Compile TypeScript (src/ -> dist-bot/)
pnpm start:bot          # Run the compiled bot

# Web UI
pnpm dev                # Development server (Next.js)
pnpm build && pnpm start # Production build and serve

# OCR
pnpm start:paddle-ocr-server

# Telegram Bridge
cd telegram_bridge && pip install -e .  # Install Python dependencies
cd telegram_bridge && python -m pytest tests/  # Run tests
```

## Architecture

### Three-Process Design

1. **Bot Process** (`src/index.ts` -> `dist-bot/index.js`)
   - Standalone Discord client supporting both Bot tokens and Selfbot (user tokens via discord.js-selfbot-v13)
   - Multi-account management with per-account state tracking
   - Hot-reloads `config.json` using SHA-256 hash-based change detection
   - Auto-reconnects with exponential backoff
   - Writes status to `.data/status.json`
   - Manages Telegram bridge subprocess via `processManager.ts`

2. **Web Management UI** (Next.js App Router in `app/`)
   - REST API routes in `app/api/`: account/, auth/, config/, feishu/, telegram/, watermark/, x/
   - Shared utilities in `app/api/_lib/`

3. **Telegram Bridge** (`telegram_bridge/`)
   - Python subprocess (Telethon-based) spawned by bot process
   - Auto-restart on failure (max 5 attempts, 5s delay)
   - Entry: `telegram_bridge/src/telegram_bridge/main.py`
   - Dependencies: telethon, pydantic, rapidocr-onnxruntime

### Message Flow

```
Discord Source Channel
    ↓
src/bot.ts (processAndSend) - Filters: keywords, users, OCR; Translation
    ↓
src/senderBot.ts | src/feishuSender.ts | Telegram Bridge
    ↓
Discord Webhook/Bot API | Feishu API | Telegram API
```

### Key Source Files

- `src/index.ts` - Main entry, multi-account lifecycle, config watching
- `src/bot.ts` - Message processing pipeline, filtering logic
- `src/config.ts` - Configuration types, loading, migration logic
- `src/senderBot.ts` - Discord webhook/bot API sending
- `src/feishuSender.ts` - Feishu/Lark API integration
- `src/processManager.ts` - Telegram bridge subprocess management
- `src/telegramBridgeClient.ts` - IPC client for Telegram bridge
- `src/keywordMatcher.ts` - Keyword filtering with group support
- `src/languageFilter.ts` - Language detection and filtering
- `src/watermark.ts` - Image watermark processing
- `src/externalForwarder.ts` - X/Truth Social external forwarders
- `app/api/config/route.ts` - Configuration CRUD endpoints

### TypeScript Configuration

- `tsconfig.json` - Next.js app (ESNext modules)
- `tsconfig.bot.json` - Bot compilation (CommonJS for discord.js-selfbot-v13 compatibility)

## Configuration

Copy `config.sample.json` to `config.json` before running. The bot watches this file and hot-reloads without restart.

### Config File Handling

- Atomic saves: Config writes use temp file + rename to prevent corruption
- Multi-account structure: `MultiConfig.accounts[]` contains `AccountConfig` objects
- Legacy migration: Old single-account configs auto-migrate to multi-account format
- Version tracking: `CONFIG_VERSION` in `src/config.ts` triggers automatic migrations

## Environment Variables

Optional `.env` file in project root:

```bash
# Limit available forwarding types in UI (comma-separated)
ENABLED_FORWARDING_TYPES=discord-to-discord,discord-to-telegram,telegram-to-discord,discord-to-feishu

# Custom config file path
CONFIG_PATH=/path/to/config.json
```

## Runtime Data

- `.data/status.json` - Account connection status
- `.data/telegram_login_*.json` - Telegram auth flow state
- `.data/discord_login_*.json` - Discord auth flow state
