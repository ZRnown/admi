const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("X config UI exposes twitterapi and twscrape source providers", () => {
  assert.match(html, /sourceProvider/);
  assert.match(html, /value="twitterapi"/);
  assert.match(html, /value="twscrape"/);
  assert.match(html, /twscrapeDbPath/);
  assert.match(html, /twscrape 账号库/);
});

test("X config update handler persists twscrape provider fields", () => {
  const start = html.indexOf("function updateXConfigField(field, value)");
  const end = html.indexOf("function updateXQuickMappingField", start);
  assert.ok(start > 0);
  assert.ok(end > start);
  const source = html.slice(start, end);
  assert.match(source, /sourceProvider/);
  assert.match(source, /twscrapeDbPath/);
});
