import test from "node:test";
import assert from "node:assert/strict";

import {
  detectTextWatermarkFromOCR,
  extractWavespeedOutputUrl,
  matchWatermarkRemovalTriggerKeywords,
  resolveWatermarkRemovalConfig,
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


test("shouldRetryWaveSpeedStatus retries timeout and server errors only", () => {
  assert.equal(shouldRetryWaveSpeedStatus(504), true);
  assert.equal(shouldRetryWaveSpeedStatus(500), true);
  assert.equal(shouldRetryWaveSpeedStatus(429), true);
  assert.equal(shouldRetryWaveSpeedStatus(400), false);
  assert.equal(shouldRetryWaveSpeedStatus(undefined), false);
});
