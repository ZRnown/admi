import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("telegram library account persistence keeps sync metadata", () => {
  assert.match(html, /function buildPersistedTelegramAccount\(account\)/);
  assert.match(html, /const \{ loginState, loginMessage, userInfo, \.\.\.persisted \} = account;/);
  assert.doesNotMatch(
    html,
    /const \{ loginState, loginMessage, userInfo, syncedUser, lastSyncTime, dialogsCount, \.\.\.persisted \} = account;/,
  );
});
