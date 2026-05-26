import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

test("discord metadata status handler persists discord library runtime status", () => {
  const sourcePath = path.resolve(process.cwd(), "src", "index.ts");
  const source = readFileSync(sourcePath, "utf8");
  const handlerStart = source.indexOf('discordMetadataBridgeClient.on("discord_metadata_status"');
  const handlerEnd = source.indexOf("async function hasDiscordMetadataAccounts", handlerStart);

  assert.notEqual(handlerStart, -1, "discord_metadata_status handler should exist");
  assert.notEqual(handlerEnd, -1, "discord_metadata_status handler boundary should exist");

  const handlerSource = source.slice(handlerStart, handlerEnd);

  assert.match(
    handlerSource,
    /writeDiscordLibraryStatus\s*\(/,
    "metadata bridge online events must update discord_library_status.json",
  );
});
