import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDiscordSearchableDropdownModel,
  filterDiscordNamedItems,
  getDiscordChannelEmptyMessage,
  getDiscordMetadataAccountId,
  resolveDiscordChannelNameFromCache,
  resolveDiscordChannelsFromCache,
  resolveDiscordGuildNameFromCache,
  preserveDiscordChannelsOnFetchFailure,
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


test("preserveDiscordChannelsOnFetchFailure keeps existing channels when REST fetch fails", () => {
  const existing = [{ id: '1', name: 'alpha', type: 0 }];
  assert.deepEqual(preserveDiscordChannelsOnFetchFailure(existing, [], true), existing);
  assert.deepEqual(preserveDiscordChannelsOnFetchFailure(existing, [], false), []);
});

test("filterDiscordNamedItems filters by query ignoring case and surrounding spaces", () => {
  const items = [
    { id: "guild-1", name: "Alpha Traders" },
    { id: "guild-2", name: "Beta Room" },
    { id: "guild-3", name: "Gamma Hub" },
  ];

  assert.deepEqual(filterDiscordNamedItems(items, "  beta "), [
    { id: "guild-2", name: "Beta Room" },
  ]);
  assert.deepEqual(filterDiscordNamedItems(items, "GUILD-3"), [
    { id: "guild-3", name: "Gamma Hub" },
  ]);
});

test("filterDiscordNamedItems keeps the selected item visible even when it does not match the query", () => {
  const items = [
    { id: "guild-1", name: "Alpha Traders" },
    { id: "guild-2", name: "Beta Room" },
    { id: "guild-3", name: "Gamma Hub" },
  ];

  assert.deepEqual(filterDiscordNamedItems(items, "beta", "guild-1"), [
    { id: "guild-2", name: "Beta Room" },
    { id: "guild-1", name: "Alpha Traders" },
  ]);
});

test("buildDiscordSearchableDropdownModel uses selected item name for trigger label", () => {
  const model = buildDiscordSearchableDropdownModel(
    [
      { id: "guild-1", name: "Alpha Traders" },
      { id: "guild-2", name: "Beta Room" },
    ],
    {
      selectedId: "guild-2",
      placeholderLabel: "选择服务器",
      emptyResultsLabel: "无匹配服务器",
    },
  );

  assert.equal(model.triggerLabel, "Beta Room");
  assert.equal(model.emptyLabel, "");
});

test("buildDiscordSearchableDropdownModel shows empty label when query has no matches", () => {
  const model = buildDiscordSearchableDropdownModel(
    [
      { id: "guild-1", name: "Alpha Traders" },
      { id: "guild-2", name: "Beta Room" },
    ],
    {
      query: "zzz",
      placeholderLabel: "选择服务器",
      emptyResultsLabel: "无匹配服务器",
    },
  );

  assert.equal(model.triggerLabel, "选择服务器");
  assert.equal(model.emptyLabel, "无匹配服务器");
  assert.deepEqual(model.visibleItems, []);
});

test("resolveDiscordChannelsFromCache falls back from library account id to instance account cache key", () => {
  const channels = resolveDiscordChannelsFromCache(
    {
      "instance-1:guild-1": [
        { id: "channel-1", name: "crypto-signals", type: 0 },
      ],
    },
    "library-1",
    "guild-1",
    {
      accounts: [
        { id: "instance-1", discordAccountId: "library-1" },
      ],
    } as any,
  );

  assert.deepEqual(channels, [
    { id: "channel-1", name: "crypto-signals", type: 0 },
  ]);
});

test("resolveDiscordGuildNameFromCache falls back from library account id to instance guild cache", () => {
  const guildName = resolveDiscordGuildNameFromCache(
    {
      "instance-1": {
        guilds: [
          { id: "guild-1", name: "Alpha Guild" },
        ],
      },
    },
    "library-1",
    "guild-1",
    {
      accounts: [
        { id: "instance-1", discordAccountId: "library-1" },
      ],
    } as any,
  );

  assert.equal(guildName, "Alpha Guild");
});

test("resolveDiscordChannelNameFromCache falls back from library account id to instance channel cache", () => {
  const channelName = resolveDiscordChannelNameFromCache(
    {
      "instance-1:guild-1": [
        { id: "channel-1", name: "crypto-signals", type: 0 },
      ],
    },
    "library-1",
    "guild-1",
    "channel-1",
    {
      accounts: [
        { id: "instance-1", discordAccountId: "library-1" },
      ],
    } as any,
  );

  assert.equal(channelName, "crypto-signals");
});
