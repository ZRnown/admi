import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../discord_bridge/src/discord_bridge/main.py", import.meta.url), "utf8");

test("discord delete events are bridged to bot deletion sync", () => {
  assert.match(bridgeSource, /async def on_message_delete/);
  assert.match(bridgeSource, /discord_message_delete/);
  assert.match(indexSource, /discordBridgeClient\.on\("discord_message_delete"/);
  assert.match(botSource, /handleExternalMessageDelete/);
  assert.match(botSource, /handleMessageDelete/);
  assert.match(botSource, /deleteForwardedMessage/);
});
