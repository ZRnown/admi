import test from "node:test";
import assert from "node:assert/strict";

import {
  __resetWaveSpeedRateLimiterForTests,
  detectTextWatermarkFromOCR,
  extractWavespeedOutputUrl,
  matchWatermarkRemovalTriggerKeywords,
  prepareImageForOcrAndForward,
  resolveWatermarkRemovalConfig,
  runWaveSpeedRateLimited,
  shouldApplyWatermarkAfterRemoval,
  shouldPaintIOPaintMaskPoint,
  shouldPersistWatermarkRemovalConfig,
  shouldRetryWaveSpeedStatus,
} from "../src/watermarkRemoval.ts";

test("resolveWatermarkRemovalConfig merges global api key with rule mode override", () => {
  const resolved = resolveWatermarkRemovalConfig(
    { enabled: true, mode: "always", apiKey: "global-key" },
    { enabled: true, mode: "ocr" },
  );

  assert.deepEqual(resolved, {
    enabled: true,
    mode: "ocr",
    provider: "wavespeed",
    apiKey: "global-key",
    triggerKeywords: undefined,
  });
});

test("resolveWatermarkRemovalConfig disables removal when rule explicitly turns it off", () => {
  const resolved = resolveWatermarkRemovalConfig(
    { enabled: true, mode: "always", apiKey: "global-key" },
    { enabled: false },
  );

  assert.equal(resolved, undefined);
});

test("detectTextWatermarkFromOCR matches short edge text blocks", () => {
  const result = detectTextWatermarkFromOCR({
    code: 0,
    msg: "ok",
    data: [
      {
        text: "@myshop",
        score: 0.98,
        box: [
          [870, 920],
          [980, 920],
          [980, 960],
          [870, 960],
        ],
      },
    ],
  });

  assert.equal(result.matched, true);
  assert.match(result.reason || "", /edge/i);
  assert.deepEqual(result.texts, ["@myshop"]);
});

test("detectTextWatermarkFromOCR ignores centered body text", () => {
  const result = detectTextWatermarkFromOCR({
    code: 0,
    msg: "ok",
    data: [
      {
        text: "this is a long sentence in the center of the image",
        score: 0.99,
        box: [
          [180, 350],
          [820, 350],
          [820, 450],
          [180, 450],
        ],
      },
    ],
  });

  assert.equal(result.matched, false);
});

test("extractWavespeedOutputUrl supports array and nested data payloads", () => {
  assert.equal(
    extractWavespeedOutputUrl({
      status: "completed",
      outputs: ["https://cdn.example.com/a.png"],
    }),
    "https://cdn.example.com/a.png",
  );

  assert.equal(
    extractWavespeedOutputUrl({
      data: {
        output: {
          image: "https://cdn.example.com/b.png",
        },
      },
    }),
    "https://cdn.example.com/b.png",
  );
});


test("resolveWatermarkRemovalConfig carries explicit trigger keywords", () => {
  const resolved = resolveWatermarkRemovalConfig(
    { enabled: true, mode: "ocr", apiKey: "global-key", triggerKeywords: ["抖音", "小红书"] },
    { triggerKeywords: ["视频号"] },
  );

  assert.deepEqual(resolved, {
    enabled: true,
    mode: "ocr",
    provider: "wavespeed",
    apiKey: "global-key",
    triggerKeywords: ["视频号"],
  });
});

test("matchWatermarkRemovalTriggerKeywords matches OCR text by configured keywords", () => {
  const result = matchWatermarkRemovalTriggerKeywords(
    "关注我的抖音号 @abc 官方同款",
    [["抖音"], ["小红书", "店铺"]],
  );

  assert.equal(result.matched, true);
  assert.deepEqual(result.matchedKeywords, ["抖音"]);
});


test("shouldPersistWatermarkRemovalConfig keeps keyword-only config", () => {
  assert.equal(
    shouldPersistWatermarkRemovalConfig({ triggerKeywords: ["抖音"] }),
    true,
  );
});

test("shouldPersistWatermarkRemovalConfig keeps mode-only config", () => {
  assert.equal(
    shouldPersistWatermarkRemovalConfig({ enabled: true, mode: "ocr" }),
    true,
  );
});

test("shouldPersistWatermarkRemovalConfig drops empty config", () => {
  assert.equal(
    shouldPersistWatermarkRemovalConfig({ apiKey: "", triggerKeywords: [] }),
    false,
  );
});



test("resolveWatermarkRemovalConfig enables IOPaint without Wavespeed key", () => {
  const resolved = resolveWatermarkRemovalConfig({
    enabled: true,
    mode: "ocr",
    provider: "iopaint",
    iopaintModel: "migan",
    iopaintStrategy: "crop",
    iopaintMaskMode: "protect-text",
  });

  assert.deepEqual(resolved, {
    enabled: true,
    mode: "ocr",
    provider: "iopaint",
    iopaintModel: "migan",
    iopaintStrategy: "crop",
    iopaintMaskMode: "protect-text",
    apiKey: undefined,
    triggerKeywords: undefined,
  });
});

test("resolveWatermarkRemovalConfig keeps Wavespeed compatible when api key exists", () => {
  const resolved = resolveWatermarkRemovalConfig({ enabled: true, mode: "always", apiKey: "global-key" });

  assert.equal(resolved?.provider, "wavespeed");
  assert.equal(resolved?.apiKey, "global-key");
});

test("shouldPersistWatermarkRemovalConfig keeps IOPaint model and strategy", () => {
  assert.equal(
    shouldPersistWatermarkRemovalConfig({
      provider: "iopaint",
      iopaintModel: "lama",
      iopaintStrategy: "resize",
      iopaintMaskMode: "protect-text",
    }),
    true,
  );
});

test("shouldPaintIOPaintMaskPoint protects non-watermark OCR text without color checks", () => {
  const regions = {
    watermarkBoxes: [{ minX: 10, minY: 10, maxX: 40, maxY: 40 }],
    protectBoxes: [{ minX: 20, minY: 20, maxX: 30, maxY: 30 }],
  };

  assert.equal(shouldPaintIOPaintMaskPoint(15, 15, regions, "protect-text"), true);
  assert.equal(shouldPaintIOPaintMaskPoint(25, 25, regions, "protect-text"), false);
});

test("shouldPaintIOPaintMaskPoint masks protected overlaps in box mode", () => {
  const regions = {
    watermarkBoxes: [{ minX: 10, minY: 10, maxX: 40, maxY: 40 }],
    protectBoxes: [{ minX: 20, minY: 20, maxX: 30, maxY: 30 }],
  };

  assert.equal(shouldPaintIOPaintMaskPoint(25, 25, regions, "box"), true);
});

test("detectTextWatermarkFromOCR returns matched blocks for local masks", () => {
  const block = {
    text: "@myshop",
    score: 0.98,
    box: [
      [870, 920],
      [980, 920],
      [980, 960],
      [870, 960],
    ],
  };
  const result = detectTextWatermarkFromOCR({ code: 0, msg: "ok", data: [block] });

  assert.equal(result.matched, true);
  assert.deepEqual(result.blocks, [block]);
});

test("shouldRetryWaveSpeedStatus retries timeout and server errors only", () => {
  assert.equal(shouldRetryWaveSpeedStatus(504), true);
  assert.equal(shouldRetryWaveSpeedStatus(500), true);
  assert.equal(shouldRetryWaveSpeedStatus(429), true);
  assert.equal(shouldRetryWaveSpeedStatus(400), false);
  assert.equal(shouldRetryWaveSpeedStatus(undefined), false);
});

test("shouldApplyWatermarkAfterRemoval skips new watermark when removal failed", () => {
  assert.equal(
    shouldApplyWatermarkAfterRemoval({
      hasWatermarks: true,
      isImage: true,
      removalAttempted: true,
      removalFailed: true,
    }),
    false,
  );

  assert.equal(
    shouldApplyWatermarkAfterRemoval({
      hasWatermarks: true,
      isImage: true,
      removalAttempted: true,
      removalFailed: false,
    }),
    true,
  );
});

test("prepareImageForOcrAndForward uses removed image for OCR after successful removal", async () => {
  const prepared = await prepareImageForOcrAndForward("https://cdn.example.com/original.png", {
    shouldRemoveWatermark: true,
    removeWatermark: async (imageUrl) => `${imageUrl}?clean=1`,
  });

  assert.deepEqual(prepared, {
    originalUrl: "https://cdn.example.com/original.png",
    forwardUrl: "https://cdn.example.com/original.png?clean=1",
    ocrUrl: "https://cdn.example.com/original.png?clean=1",
    removalAttempted: true,
    removalFailed: false,
  });
});

test("prepareImageForOcrAndForward falls back to original image for OCR when removal fails", async () => {
  const prepared = await prepareImageForOcrAndForward("https://cdn.example.com/original.png", {
    shouldRemoveWatermark: true,
    removeWatermark: async () => {
      throw new Error("wavespeed unavailable");
    },
  });

  assert.deepEqual(prepared, {
    originalUrl: "https://cdn.example.com/original.png",
    forwardUrl: "https://cdn.example.com/original.png",
    ocrUrl: "https://cdn.example.com/original.png",
    removalAttempted: true,
    removalFailed: true,
  });
});

test("runWaveSpeedRateLimited serializes requests and enforces interval", async () => {
  __resetWaveSpeedRateLimiterForTests();

  let now = 1000;
  const waits: number[] = [];
  const started: number[] = [];

  const wait = async (ms: number) => {
    waits.push(ms);
    now += ms;
  };

  const results = await Promise.all([
    runWaveSpeedRateLimited(
      async () => {
        started.push(now);
        return "first";
      },
      { now: () => now, wait, minIntervalMs: 2000 },
    ),
    runWaveSpeedRateLimited(
      async () => {
        started.push(now);
        return "second";
      },
      { now: () => now, wait, minIntervalMs: 2000 },
    ),
    runWaveSpeedRateLimited(
      async () => {
        started.push(now);
        return "third";
      },
      { now: () => now, wait, minIntervalMs: 2000 },
    ),
  ]);

  assert.deepEqual(results, ["first", "second", "third"]);
  assert.deepEqual(started, [1000, 3000, 5000]);
  assert.deepEqual(waits, [2000, 2000]);
});

test("runWaveSpeedRateLimited enforces per-window request cap for burst uploads", async () => {
  __resetWaveSpeedRateLimiterForTests();

  let now = 1000;
  const waits: number[] = [];
  const started: number[] = [];

  const wait = async (ms: number) => {
    waits.push(ms);
    now += ms;
  };

  const results = await Promise.all([
    runWaveSpeedRateLimited(
      async () => {
        started.push(now);
        return "first";
      },
      { now: () => now, wait, minIntervalMs: 0, windowMs: 10000, maxRequestsPerWindow: 2 },
    ),
    runWaveSpeedRateLimited(
      async () => {
        started.push(now);
        return "second";
      },
      { now: () => now, wait, minIntervalMs: 0, windowMs: 10000, maxRequestsPerWindow: 2 },
    ),
    runWaveSpeedRateLimited(
      async () => {
        started.push(now);
        return "third";
      },
      { now: () => now, wait, minIntervalMs: 0, windowMs: 10000, maxRequestsPerWindow: 2 },
    ),
  ]);

  assert.deepEqual(results, ["first", "second", "third"]);
  assert.deepEqual(started, [1000, 1000, 11000]);
  assert.deepEqual(waits, [10000]);
});
