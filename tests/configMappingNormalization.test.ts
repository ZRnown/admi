import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeDiscordMappingRule,
  normalizeTelegramMapping,
} from "../src/mappingNormalization.ts";

test("normalizeDiscordMappingRule preserves display metadata and account-send fields", () => {
  const rule = normalizeDiscordMappingRule({
    id: "rule-1",
    sourceChannelId: "source-1",
    sourceGuildId: "guild-1",
    sourceGuildName: "Alpha Guild",
    sourceChannelName: "crypto-signals",
    targetWebhookUrl: "",
    targetChannelId: "target-1",
    targetGuildId: "target-guild-1",
    discordSenderType: "account",
    discordSenderAccountId: "library-1",
    safewAccountId: "safe-1",
  });

  assert.equal(rule.sourceGuildName, "Alpha Guild");
  assert.equal(rule.sourceChannelName, "crypto-signals");
  assert.equal(rule.targetChannelId, "target-1");
  assert.equal(rule.targetGuildId, "target-guild-1");
  assert.equal(rule.discordSenderType, "account");
  assert.equal(rule.discordSenderAccountId, "library-1");
  assert.equal(rule.safewAccountId, "safe-1");
});

test("normalizeTelegramMapping preserves Discord display metadata and sender fields", () => {
  const rule = normalizeTelegramMapping({
    id: "rule-2",
    sourceChannelId: "source-1",
    sourceGuildId: "guild-1",
    sourceGuildName: "Alpha Guild",
    sourceChannelName: "alpha-feed",
    targetChannelId: "https://discord.com/api/webhooks/demo",
    type: "telegram-to-discord",
    discordSenderType: "account",
    discordSenderAccountId: "library-1",
    targetGuildId: "target-guild-1",
  });

  assert.equal(rule.sourceGuildName, "Alpha Guild");
  assert.equal(rule.sourceChannelName, "alpha-feed");
  assert.equal(rule.discordSenderType, "account");
  assert.equal(rule.discordSenderAccountId, "library-1");
  assert.equal(rule.targetGuildId, "target-guild-1");
});

test("normalizeDiscordMappingRule parses Discord channel links into channel and guild ids", () => {
  const rule = normalizeDiscordMappingRule({
    sourceChannelId: "https://discord.com/channels/422500326654869505/1391569590969958542/1490340117020413962",
    targetWebhookUrl: "https://discord.com/api/webhooks/demo",
  });

  assert.equal(rule.sourceChannelId, "1391569590969958542");
  assert.equal(rule.sourceGuildId, "422500326654869505");
});

test("normalizeTelegramMapping parses Discord channel links into channel and guild ids", () => {
  const rule = normalizeTelegramMapping({
    sourceChannelId: "https://discord.com/channels/422500326654869505/1391569590969958542",
    targetChannelId: "123456",
    type: "discord-to-telegram",
  });

  assert.equal(rule.sourceChannelId, "1391569590969958542");
  assert.equal(rule.sourceGuildId, "422500326654869505");
});

test("normalizeDiscordMappingRule preserves mobile client rules without a target webhook", () => {
  const rule = normalizeDiscordMappingRule({
    id: "rule-mobile",
    sourceChannelId: "source-mobile",
    targetWebhookUrl: "",
    targetChannelId: "",
    safewAccountId: "",
    mobileClientCategoryName: "一级智囊团",
    mobileClientChannelName: "自定义Discord频道",
    mobileClientChannelAvatarUrl: "https://example.com/discord-channel.png",
  });

  assert.equal(rule.id, "rule-mobile");
  assert.equal(rule.sourceChannelId, "source-mobile");
  assert.equal(rule.targetWebhookUrl, "");
  assert.equal(rule.targetChannelId, undefined);
  assert.equal(rule.safewAccountId, undefined);
  assert.equal(rule.mobileClientCategoryName, "一级智囊团");
  assert.equal(rule.mobileClientChannelName, "自定义Discord频道");
  assert.equal(rule.mobileClientChannelAvatarUrl, "https://example.com/discord-channel.png");
});

test("normalizeTelegramMapping preserves mobile client rules without a target channel", () => {
  const rule = normalizeTelegramMapping({
    id: "rule-telegram-mobile",
    sourceChannelId: "-1003795790190",
    sourceThreadId: "12345",
    targetChannelId: "",
    type: "telegram-to-mobile-client",
    mobileClientCategoryName: "大镖客vip会员群",
    mobileClientChannelName: "自定义Telegram频道",
    mobileClientChannelAvatarUrl: "https://example.com/tg-channel.png",
  });

  assert.equal(rule.id, "rule-telegram-mobile");
  assert.equal(rule.sourceChannelId, "-1003795790190");
  assert.equal(rule.sourceThreadId, "12345");
  assert.equal(rule.targetChannelId, "");
  assert.equal(rule.type, "telegram-to-mobile-client");
  assert.equal(rule.mobileClientCategoryName, "大镖客vip会员群");
  assert.equal(rule.mobileClientChannelName, "自定义Telegram频道");
  assert.equal(rule.mobileClientChannelAvatarUrl, "https://example.com/tg-channel.png");
});
