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
