const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routeSource = fs.readFileSync(path.join(__dirname, "..", "app", "api", "config", "route.ts"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const channelAvatarUploadRoute = fs.existsSync(path.join(__dirname, "..", "app", "api", "mobile-channel-avatar", "upload", "route.ts"))
  ? fs.readFileSync(path.join(__dirname, "..", "app", "api", "mobile-channel-avatar", "upload", "route.ts"), "utf8")
  : "";

test("discord mobile client rules can persist with only a source channel", () => {
  assert.match(routeSource, /function shouldKeepMobileClientSourceOnlyMapping\(/);
  assert.match(routeSource, /forwardingType === "discord-to-mobile-client"/);
  assert.match(routeSource, /forwardingType === "telegram-to-mobile-client"/);
  assert.match(routeSource, /const shouldKeepDraftMapping = shouldKeepMobileClientDraftMapping\(dto, mapping\);/);
  assert.match(routeSource, /if \(\(key \|\| shouldKeepDraftMapping\) && \(targetWebhookUrl \|\| targetChannelId \|\| shouldKeepMobileClientSourceOnlyMapping\(dto\) \|\| shouldKeepDraftMapping\)\)/);
  assert.match(routeSource, /mobileClientTarget: mergeMobileClientTarget\(dto, base\),/);
  assert.match(routeSource, /function withDefaultMobileClientTarget\(/);
});

test("discord mobile client rules are returned to the admin after refresh", () => {
  assert.match(routeSource, /function shouldExposeMobileClientSourceOnlyMapping\(/);
  assert.match(routeSource, /function shouldExposeMobileClientDraftMapping\(/);
  assert.match(routeSource, /function isMobileClientForwardingEnabled\(/);
  assert.match(routeSource, /account\.forwardingType === "discord-to-mobile-client"/);
  assert.match(routeSource, /account\.forwardingType === "telegram-to-mobile-client"/);
  assert.match(routeSource, /if \(!savedRule\?\.sourceChannelId && !shouldExposeMobileClientDraftMapping\(account, savedRule\)\) continue;/);
  assert.match(routeSource, /if \(!savedRule\?\.targetWebhookUrl && !\(savedRule as any\)\?\.targetChannelId && !shouldExposeMobileClientSourceOnlyMapping\(account\) && !shouldExposeMobileClientDraftMapping\(account, savedRule\)\) continue;/);
});

test("adding a mobile client source rule saves immediately before refresh", () => {
  const addStart = htmlSource.indexOf("function addMapping(explicitType)");
  const addEnd = htmlSource.indexOf("function getExternalMappingList", addStart);
  assert.ok(addStart > 0);
  assert.ok(addEnd > addStart);
  const addSource = htmlSource.slice(addStart, addEnd);

  assert.match(addSource, /if \(forwardingType === 'discord-to-mobile-client' \|\| forwardingType === 'telegram-to-mobile-client'\) \{/);
  assert.match(addSource, /saveConfigImmediate\(\)\.catch\(\(e\) => console\.error\('保存新增手机客户端规则失败', e\)\);/);
});

test("empty frontend discord account library preserves the existing library and instance link", () => {
  assert.match(routeSource, /function resolveLinkedDiscordAccountId\(/);
  assert.match(routeSource, /discordAccountId: resolveLinkedDiscordAccountId\(dto, base\),/);
  assert.match(routeSource, /const hasIncomingDiscordAccountLibrary = Array\.isArray\(body\.discordAccounts\);/);
  assert.match(routeSource, /const shouldPreserveDiscordAccounts =\s*hasIncomingDiscordAccountLibrary &&\s*body\.discordAccounts\.length === 0 &&\s*\(current\.discordAccounts \|\| \[\]\)\.length > 0;/);
});

test("mobile client rules expose category input and can be reordered", () => {
  assert.match(routeSource, /mobileClientCategoryName:/);
  assert.match(routeSource, /typeof mapping\.mobileClientCategoryName === "string"/);
  assert.match(htmlSource, /placeholder="客户端分类"/);
  assert.match(routeSource, /mobileClientChannelName:/);
  assert.match(routeSource, /typeof mapping\.mobileClientChannelName === "string"/);
  assert.match(htmlSource, /placeholder="客户端频道名"/);
  assert.match(htmlSource, /'mobileClientChannelName'/);
  assert.match(routeSource, /mobileClientChannelAvatarUrl:/);
  assert.match(routeSource, /mobileClientChannelAvatarUrl\.trim\(\)/);
  assert.match(htmlSource, /uploadMobileClientChannelAvatar\(this, \$\{originalIndex\}\)/);
  assert.match(htmlSource, /clearMobileClientChannelAvatar\(\$\{originalIndex\}\)/);
  assert.match(htmlSource, /\/api\/mobile-channel-avatar\/upload/);
  assert.match(htmlSource, /'mobileClientChannelAvatarUrl'/);
  assert.match(htmlSource, /function moveMapping\(/);
  assert.match(htmlSource, /moveMapping\(\$\{originalIndex\}, -1, '\$\{forwardingType\}'\)/);
  assert.match(htmlSource, /moveMapping\(\$\{originalIndex\}, 1, '\$\{forwardingType\}'\)/);
});

test("mobile client channel avatar uses local image upload", () => {
  assert.match(htmlSource, /function renderMobileClientChannelAvatarControl\(m, originalIndex\)/);
  assert.match(htmlSource, /accept="image\/\*"/);
  assert.doesNotMatch(htmlSource, /placeholder="频道头像 URL"/);
  assert.match(channelAvatarUploadRoute, /mobile_channel_avatars/);
  assert.match(channelAvatarUploadRoute, /mobileChannelAvatarUrl/);
});

test("mobile client instances require every rule to have a category before start", () => {
  assert.match(htmlSource, /function validateMobileClientCategoriesForStart\(/);
  assert.match(routeSource, /function validateMobileClientCategoriesForStart\(/);
  assert.match(htmlSource, /请先填写每条手机客户端规则的客户端分类/);
  assert.match(routeSource, /请先填写每条手机客户端规则的客户端分类/);
  assert.match(htmlSource, /validateMobileClientCategoriesForStart\(acc, type\)/);
  assert.match(routeSource, /nextAccount\.loginRequested = false;/);
  assert.match(routeSource, /nextAccount\.loginState = "error";/);
});

test("telegram mobile client instances validate the selected listener account", () => {
  assert.match(htmlSource, /type === 'telegram-to-mobile-client'\)[\s\S]*acc\.telegramListenerAccountId/);
});

test("telegram mobile client rules expose a source topic id", () => {
  assert.match(routeSource, /sourceThreadId:/);
  assert.match(htmlSource, /sourceThreadId/);
  assert.match(htmlSource, /function renderTelegramSourceTopicSelect\(/);
  assert.match(htmlSource, /data-telegram-topic-account-id/);
  assert.match(htmlSource, /onTelegramSourceDialogChange\(/);
  assert.match(htmlSource, /'sourceThreadId'/);
});

test("mapping rows show the per-rule translation selector", () => {
  const rowStart = htmlSource.indexOf("renderSourceChannelInput(acc, m, originalIndex, forwardingType, sourcePlaceholder)");
  const rowEnd = htmlSource.indexOf("removeMapping(${originalIndex})", rowStart);
  assert.ok(rowStart > 0);
  assert.ok(rowEnd > rowStart);
  const rowSource = htmlSource.slice(rowStart, rowEnd);

  assert.match(rowSource, /translateDirection/);
  assert.match(rowSource, /关闭翻译|自动检测|中 → 英|英 → 中/);
});

test("mobile client admin exposes translation and bot-only filtering", () => {
  assert.match(htmlSource, /启用自动翻译/);
  assert.match(htmlSource, /translationProvider/);
  assert.match(htmlSource, /translationApiKey/);
  assert.match(htmlSource, /translationBaseUrl/);
  assert.match(htmlSource, /translationModel/);
  assert.match(htmlSource, /translationPrompt/);
  assert.match(htmlSource, /onlyBot/);
  assert.match(htmlSource, /只转发机器人消息/);
});

test("mobile client rules persist bot-only filtering", () => {
  assert.match(routeSource, /onlyBot\?: boolean/);
  assert.match(routeSource, /onlyBot: savedRule\.onlyBot/);
  assert.match(routeSource, /onlyBot: mapping\.onlyBot/);
  assert.match(routeSource, /onlyBot: raw\.onlyBot === true \? true : undefined/);
});
