import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Jimp from "jimp";

import {
  __resetWaveSpeedRateLimiterForTests,
  detectTextWatermarkFromOCR,
  extractWavespeedOutputUrl,
  getIOPaintTextRepairBlocks,
  matchWatermarkRemovalTriggerKeywords,
  prepareImageForOcrAndForward,
  removeWatermarkFromImageUrl,
  resolveIOPaintManualMaskBlocks,
  resolveIOPaintMaskRegions,
  resolveIOPaintTextRepairFontConfig,
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

test("detectTextWatermarkFromOCR ignores repeated numeric edge prices", () => {
  const result = detectTextWatermarkFromOCR({
    code: 0,
    msg: "success",
    data: [
      {
        box: [
          [31, 223],
          [267, 218],
          [269, 276],
          [33, 281],
        ],
        score: 0.99,
        text: "2,390.92",
      },
      {
        box: [
          [810, 639],
          [881, 639],
          [881, 667],
          [810, 667],
        ],
        score: 0.99,
        text: "2,390.92",
      },
    ],
  });

  assert.equal(result.matched, false);
});

test("detectTextWatermarkFromOCR matches account watermark text with 账号", () => {
  const result = detectTextWatermarkFromOCR({
    code: 0,
    msg: "success",
    data: [
      {
        box: [
          [37, 15],
          [606, 7],
          [606, 41],
          [37, 49],
        ],
        score: 0.89,
        text: "ETHUSDT永续Discord账号：btcVvbtc",
      },
      {
        box: [
          [53, 1247],
          [157, 1247],
          [157, 1271],
          [53, 1271],
        ],
        score: 0.98,
        text: "05-0604:00",
      },
    ],
  });

  assert.equal(result.matched, true);
  assert.match(result.reason || "", /hint/i);
});

test("detectTextWatermarkFromOCR prefers watermark hints over generic edge titles", () => {
  const result = detectTextWatermarkFromOCR({
    code: 0,
    msg: "success",
    data: [
      {
        box: [
          [40, 55],
          [299, 55],
          [299, 120],
          [40, 120],
        ],
        score: 0.99,
        text: "最近调仓",
      },
      {
        box: [
          [495, 566],
          [816, 566],
          [816, 598],
          [495, 598],
        ],
        score: 0.97,
        text: "猛ADiscord:hu32345",
      },
      {
        box: [
          [967, 363],
          [1284, 365],
          [1284, 401],
          [967, 399],
        ],
        score: 0.99,
        text: "参考成交价421.190",
      },
    ],
  });

  assert.equal(result.matched, true);
  assert.equal(result.blocks?.[0]?.text, "猛ADiscord:hu32345");
});

test("detectTextWatermarkFromOCR includes centered watermark hints", () => {
  const result = detectTextWatermarkFromOCR({
    code: 0,
    msg: "success",
    data: [
      {
        box: [
          [40, 55],
          [299, 55],
          [299, 120],
          [40, 120],
        ],
        score: 0.99,
        text: "最近调仓",
      },
      {
        box: [
          [449, 222],
          [943, 219],
          [943, 274],
          [449, 277],
        ],
        score: 0.62,
        text: "冰糖橙聚台",
      },
      {
        box: [
          [143, 270],
          [773, 274],
          [773, 331],
          [143, 328],
        ],
        score: 0.8272559307515621,
        text: "2倍做多MUETF器DArex区",
      },
      {
        box: [
          [364, 321],
          [519, 321],
          [519, 338],
          [364, 338],
        ],
        score: 0.88,
        text: "社区网站：ftran",
      },
      {
        box: [
          [495, 566],
          [816, 566],
          [816, 598],
          [495, 598],
        ],
        score: 0.97,
        text: "猛ADiscord:hu32345",
      },
      {
        box: [
          [967, 363],
          [1284, 365],
          [1284, 401],
          [967, 399],
        ],
        score: 0.99,
        text: "参考成交价421.190",
      },
    ],
  });

  assert.equal(result.matched, true);
  assert.deepEqual(new Set(result.texts), new Set(["冰糖橙聚台", "社区网站：ftran", "猛ADiscord:hu32345"]));
  assert.equal(result.texts.includes("2倍做多MUETF器DArex区"), false);
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
    manualRegions: [
      { x: 0.1, y: 0.2, width: 0.3, height: 0.4, label: "center" },
      { x: -1, y: 2, width: 0, height: Number.NaN },
    ],
  });

  assert.deepEqual(resolved, {
    enabled: true,
    mode: "ocr",
    provider: "iopaint",
    iopaintModel: "migan",
    iopaintStrategy: "crop",
    iopaintMaskMode: "protect-text",
    manualRegions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, angle: 0, label: "center" }],
    maskColor: "#000000",
    apiKey: undefined,
    triggerKeywords: undefined,
  });
});

test("resolveIOPaintManualMaskBlocks converts percent regions to watermark boxes", () => {
  assert.deepEqual(
    resolveIOPaintManualMaskBlocks(
      [
        { x: 0.1, y: 0.2, width: 0.3, height: 0.4, label: "middle" },
        { x: 0.95, y: 0.9, width: 0.2, height: 0.2 },
      ],
      1000,
      500,
    ),
    [
      {
        text: "middle",
        maskRole: "watermark",
        box: [
          [100, 100],
          [400, 100],
          [400, 300],
          [100, 300],
        ],
      },
      {
        text: "manual-region",
        maskRole: "watermark",
        box: [
          [950, 450],
          [1000, 450],
          [1000, 500],
          [950, 500],
        ],
      },
    ],
  );
});

test("resolveIOPaintManualMaskBlocks rotates fixed regions around their center", () => {
  assert.deepEqual(
    resolveIOPaintManualMaskBlocks(
      [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, angle: 90, label: "diagonal" }],
      1000,
      500,
    ),
    [
      {
        text: "diagonal",
        maskRole: "watermark",
        box: [
          [350, 50],
          [350, 350],
          [150, 350],
          [150, 50],
        ],
      },
    ],
  );
});

test("resolveWatermarkRemovalConfig preserves fixed-region mode", () => {
  const resolved = resolveWatermarkRemovalConfig({
    enabled: true,
    mode: "fixed",
    provider: "iopaint",
    manualRegions: [{ x: 0.2, y: 0.3, width: 0.2, height: 0.1, angle: -25 }],
  });

  assert.equal(resolved?.mode, "fixed");
  assert.equal(resolved?.manualRegions?.[0]?.angle, -25);
});

test("resolveWatermarkRemovalConfig preserves mask mode and cover color", () => {
  const resolved = resolveWatermarkRemovalConfig({
    enabled: true,
    mode: "mask",
    provider: "iopaint",
    maskColor: "#12ABef",
    manualRegions: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
  });

  assert.equal(resolved?.mode, "mask");
  assert.equal(resolved?.maskColor, "#12abef");
});

test("mask mode covers only the configured fixed region", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "admi-mask-test-"));
  const inputPath = path.join(tempDir, "input.png");
  let outputPath: string | undefined;
  try {
    const source = await new Jimp(100, 100, 0xffffffff);
    await source.writeAsync(inputPath);
    const outputUrl = await removeWatermarkFromImageUrl(inputPath, {
      enabled: true,
      mode: "mask",
      provider: "iopaint",
      iopaintMaskPadding: 0,
      maskColor: "#ff0000",
      manualRegions: [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }],
    });
    outputPath = outputUrl.startsWith("file://") ? fileURLToPath(outputUrl) : outputUrl;
    const result = await Jimp.read(outputPath);
    assert.equal(result.getPixelColor(50, 50), 0xff0000ff);
    assert.equal(result.getPixelColor(10, 10), 0xffffffff);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (outputPath) await fs.rm(outputPath, { force: true });
  }
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

test("resolveIOPaintMaskRegions shrinks protect boxes for slightly more aggressive cleanup", () => {
  const regions = resolveIOPaintMaskRegions(
    [
      {
        text: "logo",
        maskRole: "watermark",
        box: [
          [10, 10],
          [100, 10],
          [100, 50],
          [10, 50],
        ],
      },
      {
        text: "body",
        maskRole: "protect",
        box: [
          [20, 20],
          [80, 20],
          [80, 40],
          [20, 40],
        ],
      },
    ],
    8,
    120,
    80,
  );

  assert.deepEqual(regions.watermarkBoxes, [{ minX: 2, minY: 2, maxX: 108, maxY: 58 }]);
  assert.deepEqual(regions.protectBoxes, [{ minX: 24, minY: 21, maxX: 76, maxY: 39 }]);
});

test("shouldPaintIOPaintMaskPoint masks protected overlaps in box mode", () => {
  const regions = {
    watermarkBoxes: [{ minX: 10, minY: 10, maxX: 40, maxY: 40 }],
    protectBoxes: [{ minX: 20, minY: 20, maxX: 30, maxY: 30 }],
  };

  assert.equal(shouldPaintIOPaintMaskPoint(25, 25, regions, "box"), true);
});

test("getIOPaintTextRepairBlocks returns protected OCR text overlapping watermark boxes", () => {
  const watermark = {
    text: "@mark",
    maskRole: "watermark" as const,
    box: [
      [10, 10],
      [60, 10],
      [60, 40],
      [10, 40],
    ],
  };
  const overlappedText = {
    text: "15.21%",
    maskRole: "protect" as const,
    box: [
      [45, 12],
      [90, 12],
      [90, 38],
      [45, 38],
    ],
  };
  const separateText = {
    text: "SOXL",
    maskRole: "protect" as const,
    box: [
      [100, 100],
      [150, 100],
      [150, 130],
      [100, 130],
    ],
  };

  assert.deepEqual(getIOPaintTextRepairBlocks([watermark, overlappedText, separateText]), [overlappedText]);
});

test("getIOPaintTextRepairBlocks skips large OCR lines to avoid repainting whole content", () => {
  const watermark = {
    text: "社区网站：ftran",
    maskRole: "watermark" as const,
    box: [
      [360, 310],
      [850, 310],
      [850, 340],
      [360, 340],
    ],
  };
  const largeLine = {
    text: "2倍做多MUETF器DArex区",
    score: 0.82,
    maskRole: "protect" as const,
    box: [
      [143, 270],
      [773, 274],
      [773, 331],
      [143, 328],
    ],
  };

  assert.deepEqual(getIOPaintTextRepairBlocks([watermark, largeLine]), []);
});

test("resolveIOPaintTextRepairFontConfig picks an installed CJK font candidate", () => {
  const config = resolveIOPaintTextRepairFontConfig({
    envFamily: undefined,
    envPath: undefined,
    candidates: ["/missing/font.ttf", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"],
    exists: (candidate) => candidate.endsWith("NotoSansCJK-Regular.ttc"),
  });

  assert.equal(config.fontPath, "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc");
  assert.equal(config.fontFamily, "Noto Sans CJK SC");
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
