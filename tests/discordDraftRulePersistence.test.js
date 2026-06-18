const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const routeSource = readFileSync(
  path.join(__dirname, "..", "app", "api", "config", "route.ts"),
  "utf8",
);

test("config route preserves incomplete discord mapping drafts with stable ids", () => {
  assert.match(routeSource, /function shouldKeepDiscordDraftMapping\(mapping: any\): boolean/);
  assert.match(routeSource, /shouldKeepMobileClientDraftMapping\(dto, mapping\) \|\| shouldKeepDiscordDraftMapping\(mapping\)/);
  assert.match(routeSource, /targetWebhookUrl \|\| targetChannelId \|\| shouldKeepMobileClientSourceOnlyMapping\(dto\) \|\| shouldKeepDraftMapping/);
});
