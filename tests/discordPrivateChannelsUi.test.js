const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const html = readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("discord ui keeps private chats separate from guilds in sync and rule selectors", () => {
  assert.match(html, /const DISCORD_PRIVATE_SCOPE_ID = '@private';/);
  assert.match(html, /privateChannels/);
  assert.match(html, /syncInfoPrivateChannelsList/);
  assert.match(html, /function getDiscordGuildSelectionItems\(accountId, selectedId\)/);
  assert.match(html, /id:\s*DISCORD_PRIVATE_SCOPE_ID,\s*name:\s*DISCORD_PRIVATE_SCOPE_LABEL/);
});

test("account library edit view exposes synced discord private chats and telegram dialogs", () => {
  assert.match(html, /function renderLibrarySyncedDataSection\(kind, id, account\)/);
  assert.match(html, /id="discord-private-channels-\$\{id\}"/);
  assert.match(html, /id="discord-guilds-\$\{id\}"/);
  assert.match(html, /id="telegram-dialogs-\$\{id\}"/);
});
