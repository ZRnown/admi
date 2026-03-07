import test from "node:test";
import assert from "node:assert/strict";

import {
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
