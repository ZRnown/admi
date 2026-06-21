const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const routeSource = readFileSync(path.join(__dirname, "..", "app", "api", "config", "route.ts"), "utf8");
const botSource = readFileSync(path.join(__dirname, "..", "src", "bot.ts"), "utf8");
const html = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("rule-level sender name keyword filters are preserved by config API", () => {
  assert.match(routeSource, /allowedSenderNameKeywords\?: string\[\];/);
  assert.match(routeSource, /blockedSenderNameKeywords\?: string\[\];/);
  assert.match(routeSource, /allowedSenderNameKeywords:\s*Array\.isArray\(raw\.allowedSenderNameKeywords\)/);
  assert.match(routeSource, /allowedSenderNameKeywords:\s*\(savedRule\.allowedSenderNameKeywords \|\| \[\]\)\.map\(String\)/);
  assert.match(routeSource, /allowedSenderNameKeywords:\s*mapping\.allowedSenderNameKeywords \|\| \[\]/);
});

test("rule dialog exposes and saves sender name keyword filters", () => {
  assert.match(html, />只发送发送人名字关键词</);
  assert.match(html, />屏蔽发送人名字关键词</);
  assert.match(html, /handleRuleKeywordEnter\(this, 'allowedSenderNameKeywords'\)/);
  assert.match(html, /handleRuleKeywordEnter\(this, 'blockedSenderNameKeywords'\)/);
  assert.match(html, /mapping\.allowedSenderNameKeywords = \[\.\.\.ruleConfigData\.allowedSenderNameKeywords\]/);
  assert.match(html, /mapping\.blockedSenderNameKeywords = \[\.\.\.ruleConfigData\.blockedSenderNameKeywords\]/);
});

test("discord runtime filters by sender display names", () => {
  assert.match(botSource, /function buildSenderNameKeywordHaystack\(message: Message, isWebhook: boolean, webhookName\?: string\): string/);
  assert.match(botSource, /parseKeywordGroups\(ruleConfig\.blockedSenderNameKeywords\)/);
  assert.match(botSource, /parseKeywordGroups\(ruleConfig\.allowedSenderNameKeywords\)/);
  assert.match(botSource, /Sender name did not match allowedSenderNameKeywords/);
  assert.match(botSource, /senderNameHay,/);
});
