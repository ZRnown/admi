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
  });

  assert.equal(rule.sourceGuildName, "Alpha Guild");
  assert.equal(rule.sourceChannelName, "crypto-signals");
  assert.equal(rule.targetChannelId, "target-1");
  assert.equal(rule.targetGuildId, "target-guild-1");
  assert.equal(rule.discordSenderType, "account");
  assert.equal(rule.discordSenderAccountId, "library-1");
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
