import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("telegram rule dialog selects resolve account ids with fallback logic", () => {
  assert.match(html, /function getTelegramRuleDialogAccountId\(acc, role\)/);
  assert.match(
    html,
    /const directId =\s*role === 'listener'[\s\S]*?const configuredAccounts = Array\.isArray\(acc\.telegramConfig\?\.accounts\)/,
  );
  assert.match(html, /const roleMatch = configuredAccounts\.find\(\(item\) => item\.role === role\);/);
  assert.match(html, /const typeMatch =[\s\S]*configuredAccounts\[0\];/);
});

test("telegram source list mode no longer silently falls back to manual input when listener is unset", () => {
  assert.match(
    html,
    /const telegramAccountId = getTelegramRuleDialogAccountId\(acc, 'listener'\);[\s\S]*?if \(isTelegramSource && mode === 'select'\) {\s*if \(!telegramAccountId\) {\s*return renderUnavailableTelegramDialogSelect\('请先选择 Telegram 监听账号'/,
  );
});

test("telegram target list mode no longer silently falls back to manual input when sender is unset", () => {
  assert.match(
    html,
    /const telegramSenderAccountId = getTelegramRuleDialogAccountId\(acc, 'sender'\);[\s\S]*?if \(\(forwardingType === 'discord-to-telegram' \|\| forwardingType === 'telegram-to-telegram'\) && mode === 'select'\) {\s*if \(!telegramSenderAccountId\) {\s*return renderUnavailableTelegramDialogSelect\('请先选择 Telegram 发送账号'\);/,
  );
});

test("telegram dialog option labels prefer meaningful names over raw numeric ids", () => {
  assert.match(html, /function getTelegramDialogOptionLabel\(dialog\)/);
  assert.match(
    html,
    /const titleLooksLikeFallback =[\s\S]*?rawTitle === id[\s\S]*?if \(titleLooksLikeFallback && usernameLabel\) {\s*return usernameLabel;/,
  );
  assert.match(html, /const name = getTelegramDialogOptionLabel\(d\);/);
});

test("telegram mobile client source rules can select a forum topic under the chosen dialog", () => {
  assert.match(html, /let cachedTelegramTopics = \{\};/);
  assert.match(html, /async function fetchTelegramTopicsForRule\(accountId, chatId\)/);
  assert.match(html, /fetch\('\/api\/metadata\/telegram\/topics'/);
  assert.match(html, /function getCachedTelegramTopicOptions\(accountId, chatId, selectedTopicId\)/);
  assert.match(html, /function renderTelegramSourceTopicSelect\(accountId, chatId, selectedTopicId, idx, inputMode\)/);
  assert.match(html, /function onTelegramSourceDialogChange\(idx, accountId, value\)/);
});

test("telegram source topic selector only appears for forum dialogs or manual mode", () => {
  assert.match(html, /function isTelegramForumDialog\(dialog\)/);
  assert.match(html, /function getCachedTelegramDialog\(accountId, chatId\)/);
  assert.match(html, /function shouldShowTelegramSourceTopicSelect\(accountId, chatId, inputMode\)/);
  assert.match(html, /if \(inputMode === 'manual'\) return Boolean\(String\(chatId \|\| ''\)\.trim\(\)\);/);
  assert.match(html, /return isTelegramForumDialog\(dialog\);/);
  assert.match(html, /dialog\.is_forum \|\| dialog\.isForum/);
  assert.match(html, /话题群/);
});

test("telegram topic selector is hidden until a forum dialog or manual chat id is chosen", () => {
  assert.match(html, /function getTelegramDialogTopicSuffix\(dialog\)/);
  assert.match(html, /function renderTelegramSourceTopicSelect\(accountId, chatId, selectedTopicId, idx, inputMode\)/);
  assert.match(html, /shouldShowTelegramSourceTopicSelect\(normalizedAccountId, normalizedChatId, inputMode\)/);
  assert.match(html, /if \(!chatId\) return false;/);
  assert.match(html, /inputMode === 'manual' && normalizedChatId/);
  assert.match(html, /forwardingType === 'telegram-to-mobile-client' && String\(m\.sourceChannelId \|\| ''\)\.trim\(\)/);
  assert.match(html, /renderTelegramSourceTopicSelect\([\s\S]*getRuleInputMode\(m\)/);
  assert.match(html, /return '';/);
});

test("telegram mobile client source dialog changes rerender the topic selector", () => {
  assert.match(html, /function updateMapping\(idx, field, value\)/);
  assert.match(
    html,
    /const shouldRerender =\s*field === 'inputMode' \|\|\s*\(field === 'sourceChannelId' && forwardingType === 'telegram-to-mobile-client'\);/,
  );
});

test("telegram forum topic selector appears while topics are loading or cached", () => {
  assert.match(
    html,
    /const topicCacheKey = `\$\{String\(accountId \|\| ''\)\.trim\(\)\}:\$\{String\(chatId \|\| ''\)\.trim\(\)\}`;[\s\S]*?if \(cachedTelegramTopicsLoading\[topicCacheKey\]\) return true;[\s\S]*?if \(\(cachedTelegramTopics\[topicCacheKey\] \|\| \[\]\)\.length > 0\) return true;/,
  );
  assert.match(
    html,
    /const topicPromise = value\s*\? fetchTelegramTopicsForRule\(accountId, value\)\s*: Promise\.resolve\(\[\]\);[\s\S]*?updateMapping\(idx, 'sourceChannelId', value\);[\s\S]*?topicPromise\.then\(\(\) => \{/,
  );
});

test("telegram mobile client mappings resolve listener account before rendering topic select", () => {
  assert.match(
    html,
    /function renderMappings\(acc, forwardingType\) \{[\s\S]*?const telegramAccountId = getTelegramRuleDialogAccountId\(acc, 'listener'\);[\s\S]*?renderTelegramSourceTopicSelect\(\s*telegramAccountId,/,
  );
});

test("telegram dialog selects match saved supergroup ids with or without -100 prefix", () => {
  assert.match(html, /function normalizeTelegramDialogSelectId\(id\)/);
  assert.match(html, /return raw\.slice\(4\);/);
  assert.match(html, /normalizeTelegramDialogSelectId\(d\.id\) === normalizeTelegramDialogSelectId\(selectedId\)/);
  assert.match(html, /getCachedTelegramDialog\(accountId, chatId\)[\s\S]*normalizeTelegramDialogSelectId\(d\.id\) === normalizedChatId/);
});
