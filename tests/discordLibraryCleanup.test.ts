import test from "node:test";
import assert from "node:assert/strict";

import { clearDiscordLibraryReferences } from "../src/discordLibraryCleanup.ts";

test("clearDiscordLibraryReferences removes stale top-level and rule references", () => {
  const instances: any[] = [
    {
      discordAccountId: "deleted-library-id",
      discordSenderAccountId: "deleted-library-id",
      mappings: [{ discordSenderAccountId: "deleted-library-id" }],
      telegramConfig: {
        mappings: [{ discordSenderAccountId: "deleted-library-id" }],
      },
    },
  ];

  const changed = clearDiscordLibraryReferences(instances, []);

  assert.equal(changed, true);
  assert.equal(instances[0].discordAccountId, undefined);
  assert.equal(instances[0].discordSenderAccountId, undefined);
  assert.equal(instances[0].mappings[0].discordSenderAccountId, undefined);
  assert.equal(instances[0].telegramConfig.mappings[0].discordSenderAccountId, undefined);
});

test("clearDiscordLibraryReferences keeps valid references untouched", () => {
  const instances: any[] = [
    {
      discordAccountId: "keep-id",
      mappings: [{ discordSenderAccountId: "keep-id" }],
    },
  ];

  const changed = clearDiscordLibraryReferences(instances, ["keep-id"]);

  assert.equal(changed, false);
  assert.equal(instances[0].discordAccountId, "keep-id");
  assert.equal(instances[0].mappings[0].discordSenderAccountId, "keep-id");
});
