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

test("discord bridge private chat names include display name fallbacks", () => {
  const bridgeSource = readFileSync(path.join(__dirname, "..", "discord_bridge", "src", "discord_bridge", "main.py"), "utf8");
  assert.match(bridgeSource, /display_name/);
  assert.match(bridgeSource, /displayName/);
  assert.match(bridgeSource, /nick/);
});

test("discord metadata sync private chat names include display name fallbacks", () => {
  const routeSource = readFileSync(path.join(__dirname, "..", "app", "api", "metadata", "discord", "sync", "route.ts"), "utf8");
  assert.match(routeSource, /display_name/);
  assert.match(routeSource, /displayName/);
  assert.match(routeSource, /nick/);
  assert.match(routeSource, /explicitName === String\(channel\?\.id/);
});

test("discord metadata fallback private chat names include display name fallbacks", () => {
  const fallbackSource = readFileSync(
    path.join(__dirname, "..", "discord_bridge", "src", "discord_metadata_bridge", "fetch_channels_once.py"),
    "utf8",
  );
  assert.match(fallbackSource, /display_name/);
  assert.match(fallbackSource, /displayName/);
  assert.match(fallbackSource, /nick/);
  assert.match(fallbackSource, /explicit_name == channel_id/);
  assert.match(fallbackSource, /direct_recipient/);
});

test("discord account labels prefer synced user display names over placeholder names", () => {
  assert.match(html, /function getDiscordUserDisplayName\(user\)/);
  assert.match(html, /if \(user\.globalName\) return String\(user\.globalName\);/);
  assert.match(html, /function isDiscordPlaceholderName\(name\)/);
  assert.match(html, /const username = getLibraryAccountUsername\(\{ kind: 'discord', id: item\.id, account: item \}\);/);
  assert.match(html, /return isDiscordPlaceholderName\(item\.account\.name\) \? '' : \(item\.account\.name \|\| ''\);/);
  assert.match(html, /discordAccounts\.map\(a => `<option value="\$\{a\.id\}" \$\{senderAccountId === a\.id \? 'selected' : ''\}>\$\{escapeHtml\(getDiscordLibraryLabel\(a\)\)\}<\/option>`\)/);
  assert.match(html, /if \(remoteAcc\.syncedUser && localAcc\.syncedUser !== remoteAcc\.syncedUser\) {\s*localAcc\.syncedUser = remoteAcc\.syncedUser;\s*metadataChanged = true;\s*}/);
  assert.match(html, /if \(typeof remoteAcc\.name === 'string' && localAcc\.name !== remoteAcc\.name\) {\s*localAcc\.name = remoteAcc\.name;\s*metadataChanged = true;\s*}/);
  assert.match(html, /if \(metadataChanged\) {\s*shouldRender = true;\s*}/);
});
