const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const source = readFileSync(path.join(__dirname, "..", "src", "feishuSender.ts"), "utf8");

test("FeishuSender renders markdown links as rich text anchors", () => {
  assert.match(source, /const MARKDOWN_LINK_RE =/);
  assert.match(source, /function pushFeishuTextWithLinks\(elements: any\[\], value: string\)/);
  assert.match(source, /elements\.push\(\{ tag: "a", text: match\[1\], href: match\[2\] \}\)/);
  assert.match(source, /pushFeishuTextWithLinks\(elements, headerText \+ bodyText \+ "\\n"\)/);
  assert.match(source, /pushFeishuTextWithLinks\(elements, `\\n> \$\{e\.description\}`\)/);
});
