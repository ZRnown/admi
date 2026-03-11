# Watermark OCR Ordering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure OCR image blocking runs on the post-removal image whenever watermark removal is enabled, and falls back to OCR on the original image when removal fails.

**Architecture:** Keep watermark-removal target detection for `mode: "ocr"` on the original image, then preprocess each image once into a final forward URL plus removal status. Run OCR block/trigger checks against that prepared URL, and pass the removal status downstream so senders and the Telegram bridge do not re-run removal or add a new watermark after failure.

**Tech Stack:** TypeScript, Node test runner, Next.js/Discord bot runtime, Python Telegram bridge.

---

### Task 1: Add regression tests for preprocessing behavior

**Files:**
- Modify: `tests/watermarkRemoval.test.ts`
- Modify: `src/watermarkRemoval.ts`

**Step 1: Write the failing test**

Add tests for:
- removal success => OCR uses removed URL
- removal failure => OCR falls back to original URL and marks failure

**Step 2: Run test to verify it fails**

Run: `node --test --experimental-strip-types tests/watermarkRemoval.test.ts`

Expected: FAIL because preprocessing helper does not exist yet.

**Step 3: Write minimal implementation**

Add a small helper in `src/watermarkRemoval.ts` that prepares OCR/forward URLs and removal state using an injected remover function.

**Step 4: Run test to verify it passes**

Run: `node --test --experimental-strip-types tests/watermarkRemoval.test.ts`

Expected: PASS for new helper tests.

### Task 2: Switch `src/bot.ts` OCR ordering

**Files:**
- Modify: `src/bot.ts`

**Step 1: Use the new helper**

Keep original-image OCR only for deciding `mode: "ocr"` removal targets, then prepare assets and run OCR blocked/trigger checks on the prepared URL.

**Step 2: Preserve downstream behavior**

Attach removal state to uploads so senders reuse the prepared URL and know whether a failure happened.

**Step 3: Run targeted verification**

Run:
- `node --test --experimental-strip-types tests/watermarkRemoval.test.ts`
- `pnpm build:bot`

Expected: both pass.

### Task 3: Update sender chains to reuse prepared state

**Files:**
- Modify: `src/senderBot.ts`
- Modify: `src/feishuSender.ts`
- Modify: `src/telegramBridgeClient.ts`
- Modify: `telegram_bridge/src/telegram_bridge/media_handler.py`

**Step 1: Teach senders to trust preprocessed URLs**

If a prepared removal state is present, do not call WaveSpeed again. Use the provided URL and failure flag directly.

**Step 2: Preserve skip-watermark-on-failure**

Skip adding a new watermark when removal was attempted and failed, including in the Telegram bridge.

**Step 3: Run focused verification**

Run:
- `node --test --experimental-strip-types tests/watermarkRemoval.test.ts`
- `pnpm build:bot`
- `pnpm build`

Expected: all pass.
