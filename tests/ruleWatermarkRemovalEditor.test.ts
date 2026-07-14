import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("rule watermark removal editor exposes complete per-rule configuration", () => {
  assert.match(html, /id="ruleWatermarkRemovalMode" onchange="updateRuleWatermarkRemovalMode\(this\.value\)"/);
  assert.match(html, /watermarkRemovalConfig: mapping\.watermarkRemoval/);
  assert.match(html, /\.\.\.removalConfig,[\s\S]*provider,[\s\S]*triggerKeywords/);
  assert.match(html, /id="manualRegionPreview-rule"/);
  assert.match(html, /handleManualRegionImage\('rule', this\)/);
});

test("manual removal regions support moving and rotating on the reference image", () => {
  assert.match(html, /function beginManualRegionMove\(/);
  assert.match(html, /function beginManualRegionRotate\(/);
  assert.match(html, /onpointerdown="beginManualRegionMove\('\$\{accountId\}', \$\{idx\}, event\)"/);
  assert.match(html, /onpointerdown="beginManualRegionRotate\('\$\{accountId\}', \$\{idx\}, event\)"/);
});

test("account-level IOPaint fields persist before rerendering", () => {
  const start = html.indexOf("function updateWatermarkRemovalField(");
  const end = html.indexOf("function ensureWatermarkItem(", start);
  const updateFunction = start >= 0 && end > start ? html.slice(start, end) : "";
  assert.match(updateFunction, /saveConfig\(\);\s*render\(\);/);
  assert.doesNotMatch(updateFunction, /persistManualRegionTarget\(accountId\)/);
});
