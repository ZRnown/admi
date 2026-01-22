# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Discord Forwarder - A message forwarding tool supporting multi-account management, multi-channel mapping, keyword filtering, auto-translation, and cross-platform forwarding (Discord-to-Discord, Discord-to-Feishu, Discord-to-Telegram).

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
pnpm dev                # Development server
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
   - REST API routes in `app/api/`: account/, config/, feishu/, telegram/

3. **Telegram Bridge** (`telegram_bridge/`)
   - Python subprocess (Telethon-based) spawned by bot process
   - Auto-restart on failure (max 5 attempts, 5s delay)
   - Entry: `telegram_bridge/src/telegram_bridge/main.py`

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
- `src/senderBot.ts` - Discord webhook/bot API sending
- `src/feishuSender.ts` - Feishu/Lark API integration
- `src/processManager.ts` - Telegram bridge subprocess management
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
