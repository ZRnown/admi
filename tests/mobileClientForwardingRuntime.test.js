const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const indexSource = fs.readFileSync(path.join(__dirname, "..", "src", "index.ts"), "utf8");
const botSource = fs.readFileSync(path.join(__dirname, "..", "src", "bot.ts"), "utf8");
const forwarderSource = fs.readFileSync(path.join(__dirname, "..", "src", "mobileClientForwarder.ts"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const telegramBridgeMainSource = fs.readFileSync(
  path.join(__dirname, "..", "telegram_bridge", "src", "telegram_bridge", "main.py"),
  "utf8",
);

test("telegram mobile client forwarding uses its own mapping type", () => {
  assert.match(
    indexSource,
    /currentForwardingType === 'telegram-to-mobile-client'[\s\S]*\? 'telegram-to-mobile-client'[\s\S]*: 'telegram-to-discord'/,
  );
  assert.doesNotMatch(indexSource, /const mobileOnlyRules =/);
  assert.match(indexSource, /const rulesToProcess = filteredRules;/);
  assert.match(indexSource, /currentForwardingType === "telegram-to-mobile-client"[\s\S]*\? "TG->Mobile"/);
});

test("telegram mobile client rules are listed as mobile targets in sync summary", () => {
  assert.match(indexSource, /mapping\?\.type === "telegram-to-mobile-client"[\s\S]*account\.mobileClientTarget\?\.enabled === true/);
  assert.match(indexSource, /mapping\.type === "telegram-to-mobile-client" \? "手机客户端" : String\(mapping\.targetChannelId\)/);
});

test("mobile client forwarding uses rule category name", () => {
  assert.match(forwarderSource, /categoryName: input\.categoryName,/);
  assert.doesNotMatch(forwarderSource, /categoryName: input\.categoryName \|\| input\.guildName/);
  assert.doesNotMatch(forwarderSource, /categoryName: input\.categoryName \|\| input\.guildName \|\| target\?\.guildName \|\| "Discord"/);
  assert.doesNotMatch(forwarderSource, /categoryName: input\.categoryName \|\| input\.guildName \|\| target\?\.guildName \|\| "Telegram"/);
  assert.match(botSource, /categoryName: ruleConfig\.mobileClientCategoryName/);
  assert.match(indexSource, /const mobileClientCategoryName =[\s\S]*rule as any\)\.mobileClientCategoryName/);
  assert.match(indexSource, /categoryName: mobileClientCategoryName,/);
  const mobileBlockStart = indexSource.indexOf("const mobileClientCategoryName =");
  const mobileBlockEnd = indexSource.indexOf("recordForwardStat(account.id, \"telegram-to-mobile-client\")", mobileBlockStart);
  assert.ok(mobileBlockStart > 0);
  assert.ok(mobileBlockEnd > mobileBlockStart);
  const mobileBlock = indexSource.slice(mobileBlockStart, mobileBlockEnd);
  assert.doesNotMatch(mobileBlock, /categoryName:\s*(?:undefined|"Discord"|"Telegram"|"同步频道")/);
});

test("telegram mobile client forwarding prefers a saved channel name over raw id", () => {
  assert.match(indexSource, /const mobileClientChannelName =/);
  assert.match(indexSource, /rule as any\)\.mobileClientChannelName/);
  assert.match(indexSource, /rule as any\)\.sourceChannelName/);
  assert.match(indexSource, /rule as any\)\.note/);
  assert.match(indexSource, /channelName: mobileClientChannelName,/);
});

test("discord mobile client forwarding prefers a saved channel display name", () => {
  assert.match(botSource, /mobileClientChannelName\?: string;/);
  assert.match(botSource, /mobileClientChannelName:[\s\S]*rule\.mobileClientChannelName\.trim\(\)/);
  assert.match(botSource, /channelName: ruleConfig\.mobileClientChannelName \|\| \(message\.channel as any\)\?\.name/);
});

test("telegram mobile client forwarding resolves sender name and avatar from message user info", () => {
  assert.match(indexSource, /function resolveTelegramSenderIdentity\(/);
  assert.match(indexSource, /const senderIdentity = resolveTelegramSenderIdentity\(params, account, mobileClientAdminBaseForIdentity\);/);
  assert.match(indexSource, /const senderDisplayName = senderIdentity\.displayName;/);
  assert.match(indexSource, /author: senderDisplayName,/);
  assert.match(indexSource, /authorId: senderIdentity\.id,/);
  assert.match(indexSource, /authorAvatarUrl: senderIdentity\.avatarUrl,/);
  assert.match(indexSource, /replyInfo\.from_user\?\.displayName/);
  assert.match(indexSource, /function isPlaceholderTelegramDisplayName\(/);
  assert.match(indexSource, /fallbackDisplayName =/);
  assert.doesNotMatch(indexSource, /displayName =[\s\S]*\|\|\s*"Telegram User";/);
});

test("telegram bridge IPC payload keeps full sender identity for mobile client forwarding", () => {
  assert.match(telegramBridgeMainSource, /"from_user": user_info,/);
  assert.match(telegramBridgeMainSource, /"from_id": user_info\.get\("id"\),/);
});

test("telegram mobile client instance start connects selected library accounts", () => {
  assert.match(
    htmlSource,
    /if \(type === 'telegram-to-discord' \|\| type === 'telegram-to-telegram' \|\| type === 'discord-to-telegram' \|\| type === 'telegram-to-mobile-client'\) \{/,
  );
  assert.match(htmlSource, /async function connectTelegramLibraryTargetsForInstance\(targets\)/);
  assert.match(htmlSource, /await connectTelegramLibraryTargetsForInstance\(targets\)/);
  assert.match(htmlSource, /acc\.loginState = 'pending';\s*acc\.loginMessage = '启动中\.\.\.';/);
});

test("telegram mobile client instance cards use selected library account state", () => {
  const stateStart = htmlSource.indexOf("function resolveTelegramInstanceState");
  const stateEnd = htmlSource.indexOf("function resolveDiscordInstanceState", stateStart);
  const stateFunction = htmlSource.slice(stateStart, stateEnd);
  assert.match(stateFunction, /type === 'telegram-to-mobile-client'[\s\S]*acc\.telegramListenerAccountId/);

  const detailStart = htmlSource.indexOf("function buildAccountDetailHtml");
  const detailEnd = htmlSource.indexOf("if (type === 'x-to-discord')", detailStart);
  const detailFunction = htmlSource.slice(detailStart, detailEnd);
  assert.match(detailFunction, /type === 'telegram-to-mobile-client'[\s\S]*getTelegramLibraryTargetsForInstance\(acc, type\)/);

  const summaryStart = htmlSource.indexOf("function buildAccountCardSummary");
  const summaryEnd = htmlSource.indexOf("// ==================== 账号库标签函数", summaryStart);
  const summaryFunction = htmlSource.slice(summaryStart, summaryEnd);
  assert.match(summaryFunction, /type === 'telegram-to-mobile-client'[\s\S]*getTelegramLibraryTargetsForInstance\(acc, type\)/);
  assert.match(htmlSource, /if \(type === 'telegram-to-mobile-client'\) \{[\s\S]*?acc\.loginRequested = true;/);
});

test("telegram forwarding can filter a single forum topic", () => {
  assert.match(indexSource, /function getTelegramMessageTopicId\(/);
  assert.match(indexSource, /params\?\.reply_to_top_id/);
  assert.match(indexSource, /sourceThreadId/);
  assert.match(indexSource, /ruleTopicId && ruleTopicId !== messageTopicId/);
});

test("telegram mobile client forwarding exposes local media through backend route", () => {
  assert.match(indexSource, /function buildTelegramMediaUrl\(/);
  assert.match(indexSource, /\/api\/telegram\/media\//);
  assert.match(indexSource, /buildTelegramMediaUrl\(item\.localPath, item\.url, mobileClientAdminBase\)/);
  assert.match(indexSource, /function resolveMobileClientAdminBase\(/);
  assert.doesNotMatch(
    indexSource,
    /url:\s*item\.url\s*\|\|\s*item\.localPath/,
    "mobile client payload must not send local filesystem paths as attachment URLs",
  );
});
