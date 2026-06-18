const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/bot.ts"), "utf8");

test("Feishu forwarding uploads Discord embed images even without watermark rewriting", () => {
  assert.match(source, /const shouldUploadEmbedImagesForFeishu = feishuSendersForThis\.length > 0 && !skipImages/);
  assert.match(
    source,
    /const shouldRewriteEmbedImages =\s*\(\(effectiveWatermarks\.length > 0 \|\| !!effectiveWatermarkRemoval\) \|\| shouldUploadEmbedImagesForFeishu\) && !skipImages/,
  );
  assert.match(source, /if \(shouldRewriteEmbedImages\) \{\s*const embedUrls = collectEmbedImageUrls\(message\.embeds \|\| \[\]\)/);
});
