# Admi Independent Backend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow a second `admi` clone to run its own backend without colliding with the existing `/root/admi` deployment.

**Architecture:** Keep the existing single-instance defaults intact, but add env-driven runtime controls for OCR port selection, optional global Python cleanup, and Telegram session storage. Deploy the new clone with its own `config.json`, `.data`, OCR port, and pm2 backend process.

**Tech Stack:** Next.js, Node.js, TypeScript, Python bridge services, pm2

---

### Task 1: Add failing backend runtime config tests

**Files:**
- Create: `tests/backendRuntimeConfig.test.ts`
- Test: `node --test --experimental-strip-types tests/backendRuntimeConfig.test.ts`

**Step 1:** Write failing tests for default backend runtime values and env overrides.

**Step 2:** Run the targeted Node test and confirm it fails because the helper module does not exist yet.

### Task 2: Implement runtime config helper and wire Node backend

**Files:**
- Create: `src/backendRuntimeConfig.ts`
- Modify: `scripts/start-backend.js`
- Modify: `paddle_ocr_server.js`

**Step 1:** Implement a small helper that resolves OCR port and cleanup flags from env.

**Step 2:** Update `scripts/start-backend.js` to use the resolved OCR port and make global Python cleanup opt-in/out by env.

**Step 3:** Update `paddle_ocr_server.js` to read the same env-driven OCR port.

**Step 4:** Re-run the targeted Node test and keep it green.

### Task 3: Add failing Python test for Telegram session path override

**Files:**
- Modify: `telegram_bridge/tests/test_session_manager.py`

**Step 1:** Add a failing pytest case proving `TELEGRAM_SESSIONS_DIR` overrides the default session directory when no explicit argument is passed.

**Step 2:** Run the targeted pytest case and confirm it fails first.

### Task 4: Implement Telegram session directory override

**Files:**
- Modify: `telegram_bridge/src/telegram_bridge/session.py`

**Step 1:** Make `SessionManager()` respect `TELEGRAM_SESSIONS_DIR` while preserving the old `~/.telegram-sessions` fallback.

**Step 2:** Re-run the targeted pytest case and keep the existing session tests green.

### Task 5: Deploy the second independent backend

**Files:**
- Remote runtime only: `/root/admi-3111/config.json`, `/root/admi-3111/.data`, pm2 process list

**Step 1:** Sync code into `/root/admi-3111`.

**Step 2:** Set `/root/admi-3111/config.json` OCR URLs to the new OCR port.

**Step 3:** Start `admi-3222-back` with `CONFIG_PATH=/root/admi-3111/config.json`, `BACKEND_OCR_PORT=<new-port>`, `BACKEND_GLOBAL_PYTHON_CLEANUP=false`, and a local `TELEGRAM_SESSIONS_DIR`.

**Step 4:** Verify `admi-3222-web` and `admi-3222-back` are online, the new OCR port listens, and the original `/root/admi` processes stay up.
