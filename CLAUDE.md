# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Discord Forwarder - A message forwarding tool supporting multi-account management, multi-channel mapping, keyword filtering, auto-translation, and cross-platform forwarding (Discord-to-Discord, Discord-to-Feishu, Discord-to-Telegram).

## Build and Run Commands

```bash
# Install dependencies
pnpm install

# Bot (core functionality)
pnpm build:bot          # Compile TypeScript (src/ -> dist-bot/)
pnpm start:bot          # Run the compiled bot

# Web Management UI (Next.js)
pnpm dev                # Development server on port 3000
pnpm build              # Production build
pnpm start              # Production server

# OCR utilities
pnpm test:ocr
pnpm start:simple-ocr-server
pnpm start:paddle-ocr-server
```

## Architecture

### Dual-Process Design

1. **Bot Process** (`src/index.ts` -> `dist-bot/index.js`)
   - Standalone Discord client, independent of web server
   - Supports both Bot tokens and Selfbot (user tokens)
   - Hot-reloads configuration from `config.json`
   - Auto-reconnects with exponential backoff

2. **Web Management UI** (Next.js App Router in `app/`)
   - REST API at `app/api/` for configuration CRUD
   - Static admin interface served from `public/index.html`

### Message Flow

```
Discord Source Channel
    ↓
src/bot.ts (processAndSend)
    ↓ Filters: keywords, users, OCR
    ↓ Translation (optional)
    ↓
src/senderBot.ts OR src/feishuSender.ts
    ↓
Discord Webhook / Feishu API / Telegram
```

### Key Source Files

- `src/index.ts` - Main entry, account management, config watching
- `src/bot.ts` - Message processing and filtering logic
- `src/senderBot.ts` - Webhook/Bot API message sending
- `src/feishuSender.ts` - Feishu/Lark integration
- `src/config.ts` - Configuration management
- `src/ocrClient.ts` - OCR for image content filtering
- `app/api/config/route.ts` - Configuration REST API

### TypeScript Configuration

- `tsconfig.json` - Next.js app (ES2019, ESNext modules)
- `tsconfig.bot.json` - Bot compilation (ES2020, CommonJS)

## Configuration

Copy `config.sample.json` to `config.json` before running. The bot watches this file for changes and applies them without restart.

## SDD Methodology (from .cursor/rules/)

This project uses Specification-Driven Development:
- `specs/[branch]/` is the source of truth
- Workflow: Spec → Plan → Contracts → Tests → Code
- Contracts in `specs/[branch]/contracts/` define the FE/BE interface
- Backend follows Library-First and Test-First principles
- Frontend consumes contracts, uses Dumb Components + Smart Containers pattern
