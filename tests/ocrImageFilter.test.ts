import test from "node:test";
import assert from "node:assert/strict";

import {
  filterBlockedUploads,
  isBlockedImageUrl,
  markBlockedImageUrl,
  stripBlockedEmbedImages,
} from "../src/ocrImageFilter.ts";

test("filterBlockedUploads removes blocked image urls but keeps other uploads", () => {
  const blockedUrls = new Set<string>();
  markBlockedImageUrl(blockedUrls, "https://cdn.example.com/a.png?size=large");

  const filtered = filterBlockedUploads(
    [
      { url: "https://cdn.example.com/a.png", filename: "a.png", isImage: true },
      { url: "https://cdn.example.com/b.png", filename: "b.png", isImage: true },
    ],
    blockedUrls,
  );

  assert.deepEqual(filtered, [{ url: "https://cdn.example.com/b.png", filename: "b.png", isImage: true }]);
});

test("stripBlockedEmbedImages removes image but preserves embed text", () => {
  const blockedUrls = new Set<string>();
  markBlockedImageUrl(blockedUrls, "https://cdn.example.com/a.png");

  const filtered = stripBlockedEmbedImages(
    [
      {
        type: "rich",
        title: "行情说明",
        description: "这段文字应该保留",
        image: { url: "https://cdn.example.com/a.png?foo=1" },
      },
    ],
    blockedUrls,
  );

  assert.deepEqual(filtered, [
    {
      type: "rich",
      title: "行情说明",
      description: "这段文字应该保留",
    },
  ]);
});

test("stripBlockedEmbedImages drops image-only embeds", () => {
  const blockedUrls = new Set<string>();
  markBlockedImageUrl(blockedUrls, "https://cdn.example.com/only-image.png");

  const filtered = stripBlockedEmbedImages(
    [
      {
        type: "image",
        url: "https://cdn.example.com/only-image.png?x=1",
        image: { url: "https://cdn.example.com/only-image.png?x=1" },
      },
    ],
    blockedUrls,
  );

  assert.equal(filtered, undefined);
});

test("isBlockedImageUrl matches normalized urls", () => {
  const blockedUrls = new Set<string>();
  markBlockedImageUrl(blockedUrls, "https://cdn.example.com/a.png?size=large");

  assert.equal(isBlockedImageUrl(blockedUrls, "https://cdn.example.com/a.png"), true);
  assert.equal(isBlockedImageUrl(blockedUrls, "https://cdn.example.com/b.png"), false);
});
