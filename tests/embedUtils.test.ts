import test from "node:test";
import assert from "node:assert/strict";

import { stripUploadedEmbedImages } from "../src/embedUtils.ts";

test("stripUploadedEmbedImages removes duplicate embed image but keeps text", () => {
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

test("stripUploadedEmbedImages drops image-only embed when upload already carries the image", () => {
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
