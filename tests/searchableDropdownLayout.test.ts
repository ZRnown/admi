import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("rules section keeps searchable dropdowns visible", () => {
  const rulesSectionStart = html.indexOf("<!-- 转发规则 -->");
  assert.notEqual(rulesSectionStart, -1);
  const rulesSectionSnippet = html.slice(rulesSectionStart, rulesSectionStart + 500);
  assert.match(
    rulesSectionSnippet,
    /bg-white rounded-xl border border-slate-200 shadow-sm overflow-visible mb-4/,
  );
});

test("rule config modal uses inner scrolling instead of clipping dropdown panels", () => {
  assert.match(
    html,
    /<div class="bg-white rounded-xl border border-slate-200 shadow-lg p-6 w-full max-w-2xl mx-4 max-h-\[90vh\] overflow-visible">[\s\S]*?<div class="space-y-6 max-h-\[calc\(90vh-9rem\)\] overflow-y-auto pr-1">/,
  );
});
