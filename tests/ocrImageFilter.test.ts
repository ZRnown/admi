import test from "node:test";
import assert from "node:assert/strict";

import {
  filterBlockedUploads,
  isBlockedImageUrl,
  markBlockedImageUrl,
  stripAllEmbedImages,
  stripBlockedEmbedImages,
  stripUploadedEmbedImages,
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

test("stripBlockedEmbedImages keeps non-blocked rich image-only embeds", () => {
  const blockedUrls = new Set<string>();
  markBlockedImageUrl(blockedUrls, "https://cdn.example.com/other-image.png");

  const filtered = stripBlockedEmbedImages(
    [
      {
        type: "rich",
        image: { url: "https://cdn.example.com/only-image.png" },
      },
    ],
    blockedUrls,
  );

  assert.deepEqual(filtered, [
    {
      type: "rich",
      image: { url: "https://cdn.example.com/only-image.png" },
    },
  ]);
});

test("stripAllEmbedImages removes embed images but preserves textual fields", () => {
  const filtered = stripAllEmbedImages([
    {
      type: "rich",
      title: "鲸鱼提醒",
      description: "只保留这段文字",
      image: { url: "https://cdn.example.com/embed-image.png" },
      thumbnail: { url: "https://cdn.example.com/thumb.png" },
      fields: [{ name: "金额", value: "$1.2M" }],
    },
  ]);

  assert.deepEqual(filtered, [
    {
      type: "rich",
      title: "鲸鱼提醒",
      description: "只保留这段文字",
      fields: [{ name: "金额", value: "$1.2M" }],
    },
  ]);
});

test("stripAllEmbedImages drops embeds that only contain images", () => {
  const filtered = stripAllEmbedImages([
    {
      type: "image",
      url: "https://cdn.example.com/only-image.png",
      image: { url: "https://cdn.example.com/only-image.png" },
      thumbnail: { url: "https://cdn.example.com/only-image-thumb.png" },
    },
  ]);

  assert.equal(filtered, undefined);
});

test("stripAllEmbedImages drops rich embeds that only contain images", () => {
  const filtered = stripAllEmbedImages([
    {
      type: "rich",
      image: { url: "https://cdn.example.com/only-image.png" },
      thumbnail: { url: "https://cdn.example.com/only-image-thumb.png" },
    },
  ]);

  assert.equal(filtered, undefined);
});

test("isBlockedImageUrl matches normalized urls", () => {
  const blockedUrls = new Set<string>();
  markBlockedImageUrl(blockedUrls, "https://cdn.example.com/a.png?size=large");

  assert.equal(isBlockedImageUrl(blockedUrls, "https://cdn.example.com/a.png"), true);
  assert.equal(isBlockedImageUrl(blockedUrls, "https://cdn.example.com/b.png"), false);
});

test("stripUploadedEmbedImages removes embed image when the same image is uploaded as attachment", () => {
  const filtered = stripUploadedEmbedImages(
    [
      {
        type: "rich",
        title: "信号说明",
        description: "保留这段文字",
        image: { url: "https://cdn.example.com/card.png?size=large" },
      },
    ],
    [
      {
        url: "https://cdn.example.com/card.png",
        filename: "card.png",
        isImage: true,
      },
    ],
  );

  assert.deepEqual(filtered, [
    {
      type: "rich",
      title: "信号说明",
      description: "保留这段文字",
    },
  ]);
});

test("stripUploadedEmbedImages drops image-only embed when the uploaded attachment already carries the image", () => {
  const filtered = stripUploadedEmbedImages(
    [
      {
        type: "image",
        url: "https://cdn.example.com/only-image.png?x=1",
        image: { url: "https://cdn.example.com/only-image.png?x=1" },
      },
    ],
    [
      {
        url: "https://cdn.example.com/only-image.png",
        filename: "only-image.png",
        isImage: true,
      },
    ],
  );

  assert.equal(filtered, undefined);
});
