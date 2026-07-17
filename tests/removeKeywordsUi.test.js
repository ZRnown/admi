const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const pageSource = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("global removal keywords are stored as empty replacement rules", () => {
  assert.match(pageSource, /function handleRemovalKeywordEnter\(inputEl\)/);
  assert.match(pageSource, /acc\.replacements\.push\(\{ from: keyword, to: '' \}\)/);
  assert.match(pageSource, /function removeRemovalKeyword\(replacementIndex\)/);
});

test("rule editor separates removal keywords and saves them as empty replacements", () => {
  assert.match(pageSource, /removeKeywords: mappingReplacementEntries[\s\S]*String\(value \?\? ''\) === ''/);
  assert.match(pageSource, /renderRuleTags\('removeKeywords'\)/);
  assert.match(pageSource, /ruleConfigData\.removeKeywords\.forEach\(keyword =>/);
  assert.match(pageSource, /replacements\[normalized\] = ''/);
});
