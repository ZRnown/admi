const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const html = readFileSync(join(__dirname, "../public/index.html"), "utf8");
const botSource = readFileSync(join(__dirname, "../src/bot.ts"), "utf8");
const indexSource = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
const configRouteSource = readFileSync(join(__dirname, "../app/api/config/route.ts"), "utf8");

test("Feishu rules are stored as independent mapping rows instead of source-channel keyed configs", () => {
  assert.match(html, /function ensureFeishuMappings\(acc\)/);
  assert.match(html, /mapping = entries\[currentRuleConfigIndex\];/);
  assert.doesNotMatch(html, /acc\.feishuRuleConfigs\[entry\.sourceChannelId\]/);
});

test("Feishu runtime supports multiple targets for the same Discord source channel", () => {
  assert.match(indexSource, /const feishuSendersBySource = new Map<string, Array<\{ sender: FeishuSender; rule\?: any \}>>\(\);/);
  assert.match(indexSource, /existing\.push\(\{ sender: fs, rule: mapping\.rule \}\);/);
  assert.match(botSource, /private getFeishuSendersForChannel\(channelId: string\): FeishuRuntimeSender\[\]/);
  assert.match(botSource, /for \(let senderIndex = 0; senderIndex < feishuSendersForThis\.length; senderIndex\+\+\)/);
});

test("config API preserves Feishu mapping rows", () => {
  assert.match(configRouteSource, /feishuMappings: normalizeFeishuMappings\(\(account as any\)\.feishuMappings\)/);
  assert.match(configRouteSource, /const feishuMappings = normalizeFeishuMappings\(\(dto as any\)\.feishuMappings\);/);
  assert.match(configRouteSource, /feishuMappings: shouldPreserveFeishuTargets \? \(base as any\)\.feishuMappings \|\| \[\] : feishuMappings/);
});

test("Feishu rules can hide Discord source links", () => {
  assert.match(configRouteSource, /hideDiscordLinks\?: boolean;/);
  assert.match(configRouteSource, /hideDiscordLinks:\s*raw\.hideDiscordLinks === true \? true : undefined,/);
  assert.match(configRouteSource, /hideDiscordLinks:\s*savedRule\.hideDiscordLinks,/);
  assert.match(configRouteSource, /hideDiscordLinks:\s*mapping\.hideDiscordLinks,/);
  assert.match(html, /id="ruleHideDiscordLinks"/);
  assert.match(html, /mapping\.hideDiscordLinks = currentRuleConfigType === 'discord-to-feishu'/);
  assert.match(botSource, /function hideDiscordLinksInText\(value: string\): string/);
  assert.match(botSource, /hideDiscordLinksInText\(feishuContent\)/);
  assert.match(botSource, /hideDiscordLinksInEmbeds\(finalFeishuEmbeds\)/);
});
