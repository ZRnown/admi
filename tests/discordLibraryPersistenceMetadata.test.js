import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("discord library account persistence keeps sync metadata", () => {
  assert.match(html, /function buildPersistedDiscordLibraryAccount\(account\)/);
  assert.match(html, /const \{ loginState, loginMessage, \.\.\.persisted \} = account;/);
  assert.doesNotMatch(
    html,
    /const \{ loginState, loginMessage, syncedUser, lastSyncTime, guildsCount, channelsCount, \.\.\.persisted \} = account;/,
  );
});
