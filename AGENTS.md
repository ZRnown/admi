# Repository Guidelines

## Project Structure & Module Organization
- `app/` contains the Next.js App Router UI and API endpoints (see `app/api/**/route.ts`).
- `src/` is the TypeScript bot core; entry point is `src/index.ts` and process orchestration lives in `src/processManager.ts`.
- `telegram_bridge/` is the Python Telegram bridge service; sources in `telegram_bridge/src/telegram_bridge/`, tests in `telegram_bridge/tests/`.
- `public/` holds static assets for the web UI.
- `scripts/` includes helper scripts like `scripts/start-backend.js` (bootstraps bot + OCR).
- `dist-bot/`, `.data/`, and `logs/` are generated runtime/build outputs.

## Build, Test, and Development Commands
- `pnpm install`: install Node dependencies (uses `pnpm-lock.yaml`).
- `pnpm frontend`: run the Next.js UI in dev mode.
- `pnpm backend`: compile the bot, start the OCR server, and launch the bot (which manages the Telegram bridge).
- `pnpm dev`: Next.js dev server (same as `pnpm frontend`).
- `pnpm build` / `pnpm start`: production build and serve the web UI.
- `pnpm build:bot` / `pnpm start:bot`: compile the bot to `dist-bot/` and run it directly.
- `pnpm start:paddle-ocr-server` (or `pnpm start:simple-ocr-server`): run OCR independently.

## Coding Style & Naming Conventions
- TypeScript follows Prettier defaults: 2-space indentation, semicolons, double quotes (`.prettierrc`).
- ESLint is configured via `eslint.config.js` with Prettier integration; keep new code lint-clean.
- Use descriptive lowerCamelCase filenames in `src/` (e.g., `telegramBridgeClient.ts`), and Next.js API routes should remain `route.ts` under `app/api/...`.
- Python modules in `telegram_bridge/` use snake_case and follow existing formatting patterns.

## Testing Guidelines
- Python tests: `python -m pytest telegram_bridge/tests`.
- End-to-end manual checks are documented in `TESTING_GUIDE.md` (Discord ↔ Telegram flows).
- There is no JavaScript test harness yet; call out manual validation steps in PRs.

## Commit & Pull Request Guidelines
- Commit history is short and informal (e.g., `update`, `chore: ...`). Prefer concise, imperative summaries; optional Conventional Commit prefixes (`feat:`, `fix:`, `chore:`) are welcome.
- PRs should include: a brief change summary, relevant config updates (if `config.sample.json` changes), and screenshots for UI changes under `app/` or `public/`.
- List the commands you ran (e.g., `pnpm backend`, `python -m pytest telegram_bridge/tests`).

## Configuration & Secrets
- Start from `config.sample.json` and keep secrets out of git when creating `config.json`.
- `.env` is for local environment variables; do not commit sensitive values.
