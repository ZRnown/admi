# Python Full Rewrite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the project as a Python application while keeping the existing web page style, API behavior, and forwarding features unchanged.

**Architecture:** Keep `public/index.html`, `public/css/**`, and `public/js/**` as the browser UI contract. Replace the Next.js API server and TypeScript bot runtime with a FastAPI application plus Python service modules. During migration, every Python endpoint must match the existing `/api/**` path, request body, response shape, cookie behavior, and file-serving behavior.

**Tech Stack:** Python 3.11+, FastAPI, Uvicorn, Pydantic v2, aiofiles, httpx/aiohttp, pytest, pytest-asyncio, Telethon, discord.py-compatible bridge/runtime modules, Pillow, Jimp-equivalent image handling via Pillow/OpenCV where needed.

---

## Scope Rules

- Preserve the visible UI by serving the existing `public/index.html` and static assets.
- Preserve all existing `/api/**` URLs so no frontend rewrite is required.
- Do not delete TypeScript/Next files until the Python replacement has parity tests.
- Prefer compatibility tests that compare Python endpoint responses with the current API contract.
- Keep secrets in `config.json` and environment variables. Do not introduce committed secrets.
- Treat the TypeScript code as the source of truth until a Python module has equivalent tests.

## Route Inventory

The Python app must implement these 35 API routes:

- `POST /api/account/action`
- `POST /api/account/discord-login`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/status`
- `GET/POST /api/config`
- `GET /api/config/status`
- `GET /api/feishu/chats`
- `POST /api/instance/control`
- `POST /api/metadata/discord/channels`
- `POST /api/metadata/discord/guilds`
- `POST /api/metadata/discord/sync`
- `POST /api/metadata/telegram/dialogs`
- `POST /api/metadata/telegram/sync`
- `POST /api/scheduled-content/upload`
- `GET /api/telegram/avatar/{filename}`
- `POST /api/telegram/bot/connect`
- `POST /api/telegram/bot/disconnect`
- `GET /api/telegram/channels`
- `POST /api/telegram/client/connect`
- `POST /api/telegram/client/disconnect`
- `GET /api/telegram/client/session-file`
- `GET /api/telegram/client/status`
- `POST /api/telegram/login/confirm`
- `POST /api/telegram/login/start`
- `POST /api/telegram/process`
- `POST /api/telegram/send-test`
- `GET/POST/DELETE /api/telegram/session`
- `GET /api/telegram/sessions`
- `POST /api/telegram/test-connection`
- `GET /api/watermark/balance`
- `GET /api/watermark/removed/{filename}`
- `POST /api/watermark/upload`
- `GET /api/webhook-avatar/{filename}`
- `POST /api/webhook-avatar/upload`

## Task 1: Create Python Application Skeleton

**Files:**
- Create: `pyproject.toml`
- Create: `admi_server/__init__.py`
- Create: `admi_server/main.py`
- Create: `admi_server/settings.py`
- Create: `admi_server/static.py`
- Create: `tests_py/test_static_app.py`

**Step 1: Write the failing test**

```python
from fastapi.testclient import TestClient
from admi_server.main import create_app


def test_serves_index_html():
    client = TestClient(create_app())
    response = client.get("/")
    assert response.status_code == 200
    assert "转发狗" in response.text


def test_serves_public_asset():
    client = TestClient(create_app())
    response = client.get("/css/styles.css")
    assert response.status_code == 200
    assert "text/css" in response.headers["content-type"]
```

**Step 2: Run test to verify it fails**

Run:

```bash
python -m pytest tests_py/test_static_app.py -q
```

Expected: FAIL because `admi_server` does not exist.

**Step 3: Implement minimal FastAPI app**

Create `admi_server/main.py`:

```python
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / "public"


def create_app() -> FastAPI:
    app = FastAPI(title="Admi")
    app.mount("/css", StaticFiles(directory=PUBLIC_DIR / "css"), name="css")
    app.mount("/js", StaticFiles(directory=PUBLIC_DIR / "js"), name="js")

    @app.get("/")
    @app.get("/index.html")
    async def index():
        return FileResponse(PUBLIC_DIR / "index.html")

    return app


app = create_app()
```

**Step 4: Run test to verify it passes**

Run:

```bash
python -m pytest tests_py/test_static_app.py -q
```

Expected: PASS.

**Step 5: Commit**

```bash
git add pyproject.toml admi_server tests_py/test_static_app.py
git commit -m "feat: add python app skeleton"
```

## Task 2: Port Auth and Shared Utilities

**Files:**
- Create: `admi_server/auth.py`
- Create: `admi_server/config_store.py`
- Create: `admi_server/routes/auth.py`
- Test: `tests_py/test_auth_routes.py`

**Step 1: Write tests for login status and cookie behavior**

Test:
- default user/password are `admin` / `admin123` when `config.json` lacks login fields
- successful login sets `auth_token`
- status returns `authenticated: true` when cookie matches `.data/auth.json`
- logout clears token

**Step 2: Implement config file helpers**

Port behavior from:
- `app/api/_lib/auth.ts`
- `app/api/auth/login/route.ts`
- `app/api/auth/logout/route.ts`
- `app/api/auth/status/route.ts`
- `src/config.ts` only as much as auth needs

**Step 3: Wire routes into `create_app()`**

Mount router under `/api/auth`.

**Step 4: Verify**

Run:

```bash
python -m pytest tests_py/test_auth_routes.py -q
```

**Step 5: Commit**

```bash
git add admi_server tests_py
git commit -m "feat: port auth routes to python"
```

## Task 3: Port Config Read/Write API

**Files:**
- Create: `admi_server/models/config.py`
- Create: `admi_server/routes/config.py`
- Test: `tests_py/test_config_routes.py`

**Step 1: Write compatibility tests**

Cover:
- `GET /api/config?includeSecrets=1`
- secret masking when `includeSecrets` is absent
- `POST /api/config` preserves existing secrets when masked values are submitted
- `enabledForwardingTypes`, `accounts`, `discordAccounts`, `telegramAccounts`, `truthSocialAccounts`
- watermark removal config including `manualRegions`

**Step 2: Port normalization behavior**

Port from:
- `src/config.ts`
- `app/api/config/route.ts`
- `src/configStatusPayload.ts`

**Step 3: Verify**

Run:

```bash
python -m pytest tests_py/test_config_routes.py -q
```

**Step 4: Commit**

```bash
git add admi_server tests_py
git commit -m "feat: port config api to python"
```

## Task 4: Port Status and Instance Control

**Files:**
- Create: `admi_server/status_store.py`
- Create: `admi_server/routes/instance.py`
- Test: `tests_py/test_instance_routes.py`

**Step 1: Write tests**

Cover:
- `.data/status.json` read/write behavior
- `/api/config/status`
- `/api/instance/control`
- `/api/account/action`

**Step 2: Port runtime state model**

Port behavior from:
- `app/api/_lib/common.ts`
- `app/api/config/status/route.ts`
- `app/api/instance/control/route.ts`
- `app/api/account/action/route.ts`

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_instance_routes.py -q
git add admi_server tests_py
git commit -m "feat: port instance control routes"
```

## Task 5: Port Upload and Static File APIs

**Files:**
- Create: `admi_server/routes/uploads.py`
- Test: `tests_py/test_upload_routes.py`

**Step 1: Write tests**

Cover:
- scheduled content upload
- webhook avatar upload and retrieval
- telegram avatar retrieval
- watermark removed image retrieval

**Step 2: Port file handling**

Port from:
- `app/api/scheduled-content/upload/route.ts`
- `app/api/webhook-avatar/upload/route.ts`
- `app/api/webhook-avatar/[filename]/route.ts`
- `app/api/telegram/avatar/[filename]/route.ts`
- `app/api/watermark/removed/[filename]/route.ts`

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_upload_routes.py -q
git add admi_server tests_py
git commit -m "feat: port upload routes"
```

## Task 6: Port Telegram Bridge Client and Routes

**Files:**
- Create: `admi_server/telegram_bridge_client.py`
- Create: `admi_server/routes/telegram.py`
- Test: `tests_py/test_telegram_routes.py`

**Step 1: Write tests with fake bridge**

Cover:
- login start/confirm file handoff compatibility
- bot/client connect/disconnect
- channels/dialog metadata
- session file and session list behavior

**Step 2: Port IPC client**

Port from:
- `src/telegramBridgeClient.ts`
- `app/api/telegram/**`

Reuse existing Python `telegram_bridge` service wherever possible.

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_telegram_routes.py -q
git add admi_server tests_py
git commit -m "feat: port telegram api routes"
```

## Task 7: Port Discord Metadata and Runtime

**Files:**
- Create: `admi_server/discord_bridge_client.py`
- Create: `admi_server/routes/discord.py`
- Create: `admi_runtime/discord_forwarder.py`
- Test: `tests_py/test_discord_routes.py`

**Step 1: Write tests**

Cover:
- metadata sync
- guild/channel listing
- account login route
- status normalization

**Step 2: Port bridge interactions**

Port from:
- `src/discordBridgeClient.ts`
- `src/discordMetadataBridgeClient.ts`
- `src/discordMetadataHelpers.ts`
- `app/api/metadata/discord/**`
- `app/api/account/discord-login/route.ts`

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_discord_routes.py -q
git add admi_server admi_runtime tests_py
git commit -m "feat: port discord metadata api"
```

## Task 8: Port Message Processing Core

**Files:**
- Create: `admi_runtime/config.py`
- Create: `admi_runtime/filters.py`
- Create: `admi_runtime/replacements.py`
- Create: `admi_runtime/embed_utils.py`
- Create: `admi_runtime/sender.py`
- Test: `tests_py/test_runtime_filters.py`

**Step 1: Write tests from existing TS behavior**

Mirror:
- `tests/embedReplacement.test.ts`
- `tests/replacementDictionaryRuntime.test.js`
- `tests/ignored-images-policy.test.ts`
- `tests/webhookIdentity.test.ts`
- `tests/configMappingNormalization.test.ts`

**Step 2: Port modules**

Port from:
- `src/bot.ts`
- `src/senderBot.ts`
- `src/embedUtils.ts`
- `src/messageFilterDecisions.ts`
- `src/replacementDictionary.ts`
- `src/mappingNormalization.ts`
- `src/webhookIdentity.ts`

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_runtime_filters.py -q
git add admi_runtime tests_py
git commit -m "feat: port message filtering core"
```

## Task 9: Port OCR and Watermark Removal

**Files:**
- Create: `admi_runtime/ocr.py`
- Create: `admi_runtime/watermark.py`
- Create: `admi_runtime/watermark_removal.py`
- Test: `tests_py/test_watermark_removal.py`

**Step 1: Write parity tests**

Mirror:
- `tests/ocrImageFilter.test.ts`
- `tests/watermarkRemoval.test.ts`
- `tests/wavespeedAccount.test.ts`

**Step 2: Port image logic**

Port from:
- `src/ocrClient.ts`
- `src/ocrImageFilter.ts`
- `src/watermark.ts`
- `src/watermarkRemoval.ts`
- `src/wavespeedAccount.ts`
- `telegram_bridge/src/telegram_bridge/wavespeed_watermark_remover.py`

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_watermark_removal.py -q
git add admi_runtime tests_py
git commit -m "feat: port watermark removal"
```

## Task 10: Port External Forwarders

**Files:**
- Create: `admi_runtime/external_forwarder.py`
- Test: `tests_py/test_external_forwarder.py`

**Step 1: Write tests**

Cover:
- X polling/websocket config parsing
- TruthSocial polling
- rule status updates
- forward stats

**Step 2: Port from TypeScript**

Port from:
- `src/externalForwarder.ts`
- `src/forwardStats.ts`
- `src/dingtalkSender.ts`
- `src/feishuSender.ts`

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_external_forwarder.py -q
git add admi_runtime tests_py
git commit -m "feat: port external forwarders"
```

## Task 11: Add Python Process Entrypoints

**Files:**
- Create: `admi_runtime/main.py`
- Create: `admi_server/cli.py`
- Modify: `pyproject.toml`
- Create: `scripts/start-python-backend.sh`
- Test: `tests_py/test_cli.py`

**Step 1: Write tests**

Cover:
- `admi-server` command imports and creates app
- `admi-runtime` command can load config
- backend startup config reads env values

**Step 2: Implement console scripts**

Add to `pyproject.toml`:

```toml
[project.scripts]
admi-server = "admi_server.cli:main"
admi-runtime = "admi_runtime.main:main"
```

**Step 3: Verify and commit**

```bash
python -m pytest tests_py/test_cli.py -q
git add pyproject.toml admi_server admi_runtime scripts tests_py
git commit -m "feat: add python entrypoints"
```

## Task 12: Replace Node Project Commands

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Create: `requirements.lock` or `uv.lock`
- Remove only after parity: `app/`, `src/`, `tsconfig*.json`, `next.config.mjs`, Node-only scripts

**Step 1: Verify full Python suite**

Run:

```bash
python -m pytest tests_py -q
```

**Step 2: Verify browser UI**

Run:

```bash
uvicorn admi_server.main:app --host 127.0.0.1 --port 3000
```

Then verify:
- login page
- config load/save
- account library
- forwarding rules
- watermark removal settings
- upload flows

**Step 3: Remove Node-only code after parity**

Only after all Python parity tests and browser checks pass.

**Step 4: Commit**

```bash
git add .
git commit -m "chore: switch project to python runtime"
```

## Final Verification

Run:

```bash
python -m pytest tests_py -q
uvicorn admi_server.main:app --host 127.0.0.1 --port 3000
```

Manual browser checks:
- `/` serves the same page style
- existing `config.json` loads
- login/logout works
- config save does not erase secrets
- Discord account library sync works
- Telegram account library connect/sync works
- all forwarding rule forms still save the same JSON shape
- watermark removal config including manual percent regions works
- runtime can forward a controlled test message

## Rollback Plan

- Keep TypeScript files until final parity is proven.
- Each task is committed separately.
- If a task fails, revert only that task commit.
- Existing `main` remains deployable until the final Python runtime switch commit is accepted.
