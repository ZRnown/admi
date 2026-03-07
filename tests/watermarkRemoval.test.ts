import test from "node:test";
import assert from "node:assert/strict";

import {
  detectTextWatermarkFromOCR,
  extractWavespeedOutputUrl,
  resolveWatermarkRemovalConfig,
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
