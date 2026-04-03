const test = require("node:test");
const assert = require("node:assert/strict");

const { applyNativePreviewLinkMediaPolicy } = require("../dist-bot/embedUtils.js");

test("applyNativePreviewLinkMediaPolicy clears uploads and embeds for Tenor links", () => {
  const result = applyNativePreviewLinkMediaPolicy({
    rawContent: "https://tenor.com/view/shrek-reaction-really-gif-27425089",
    uploads: [
      {
        url: "https://media.tenor.com/example.gif",
        filename: "embed.gif",
        isImage: true,
      },
    ],
    extraEmbeds: [
      {
        type: "image",
        url: "https://media.tenor.com/example.gif",
        image: { url: "https://media.tenor.com/example.gif" },
      },
    ],
  });

  assert.deepEqual(result.uploads, []);
  assert.equal(result.extraEmbeds, undefined);
});

test("applyNativePreviewLinkMediaPolicy clears uploads and embeds for X links", () => {
  const result = applyNativePreviewLinkMediaPolicy({
    rawContent: "<https://x.com/example/status/1234567890>",
    uploads: [
      {
        url: "https://pbs.twimg.com/media/example.jpg",
        filename: "tweet.jpg",
        isImage: true,
      },
    ],
    extraEmbeds: [
      {
        type: "rich",
        title: "tweet preview",
        image: { url: "https://pbs.twimg.com/media/example.jpg" },
      },
    ],
  });

  assert.deepEqual(result.uploads, []);
  assert.equal(result.extraEmbeds, undefined);
});

test("applyNativePreviewLinkMediaPolicy keeps media for normal messages", () => {
  const uploads = [
    {
      url: "https://cdn.example.com/a.png",
      filename: "a.png",
      isImage: true,
    },
  ];
  const extraEmbeds = [
    {
      type: "rich",
      title: "保留原始 embed",
      image: { url: "https://cdn.example.com/a.png" },
    },
  ];

  const result = applyNativePreviewLinkMediaPolicy({
    rawContent: "普通消息",
    uploads,
    extraEmbeds,
  });

  assert.equal(result.uploads, uploads);
  assert.equal(result.extraEmbeds, extraEmbeds);
});
