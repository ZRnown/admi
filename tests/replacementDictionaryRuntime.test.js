const test = require("node:test");
const assert = require("node:assert/strict");
const { applyReplacementDictionaryToEmbeds } = require("../dist-bot/embedUtils.js");

function replaceDescription(input, dictionary) {
  const embeds = applyReplacementDictionaryToEmbeds([{ description: input }], dictionary);
  return embeds?.[0]?.description;
}

test("replacement handles mixed Chinese-English phrases with hidden format characters", () => {
  assert.equal(
    replaceDescription("星辰社\u200c区 xcsq.me", {
      "星辰社区 xcsq.me": "猛a社",
    }),
    "猛a社",
  );
});

test("replacement handles split Chinese-English rules with case-insensitive English matching", () => {
  assert.equal(
    replaceDescription("星辰社\u200c区 Xcsq.me", {
      "星辰社区": "猛a社",
      "xcsq.me": "猛A社",
    }),
    "猛a社 猛A社",
  );
});

test("empty replacement removes a configured keyword without dropping the message", () => {
  assert.equal(
    replaceDescription("保留内容 VIP 继续转发", {
      vip: "",
    }),
    "保留内容  继续转发",
  );
});
