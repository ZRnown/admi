import test from "node:test";
import assert from "node:assert/strict";

import {
  getDiscordChannelEmptyMessage,
  getDiscordMetadataAccountId,
  shouldReuseDiscordChannelsCache,
} from "../src/discordMetadataHelpers.ts";

test("getDiscordMetadataAccountId falls back to instance id when no library account is selected", () => {
  assert.equal(getDiscordMetadataAccountId({ discordAccountId: "lib-1", id: "inst-1" }), "lib-1");
  assert.equal(getDiscordMetadataAccountId({ id: "inst-1" }), "inst-1");
  assert.equal(getDiscordMetadataAccountId({}), "");
});

test("shouldReuseDiscordChannelsCache allows force refresh even when empty cache exists", () => {
  const cache = { "acc:guild": [] };
  assert.equal(shouldReuseDiscordChannelsCache(cache, "acc:guild"), true);
  assert.equal(shouldReuseDiscordChannelsCache(cache, "acc:guild", true), false);
  assert.equal(shouldReuseDiscordChannelsCache(cache, "missing"), false);
});


test("getDiscordChannelEmptyMessage distinguishes unsynced from synced-empty states", () => {
  assert.equal(getDiscordChannelEmptyMessage(false, 'guild-1', ''), '暂无频道（请先同步）');
  assert.equal(getDiscordChannelEmptyMessage(true, 'guild-1', ''), '暂无可用频道');
  assert.equal(getDiscordChannelEmptyMessage(false, '', ''), '请先选择服务器');
});
