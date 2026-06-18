import test from "node:test";
import assert from "node:assert/strict";

import {
  getDiscordDisconnectMessage,
  getDiscordErrorMessage,
  shouldPreserveLibraryOnlineStatus,
} from "../src/discordStatusDecisions.ts";

test("getDiscordDisconnectMessage uses a disconnect-specific fallback when no error is provided", () => {
  assert.equal(getDiscordDisconnectMessage(undefined), "连接已断开");
});

test("getDiscordErrorMessage keeps the generic failure fallback for real error states", () => {
  assert.equal(getDiscordErrorMessage(undefined), "连接失败");
});

test("getDiscordErrorMessage hides Discord token/IP risk details from the UI", () => {
  assert.equal(getDiscordErrorMessage("Improper token has been passed."), "连接失败");
});

test("shouldPreserveLibraryOnlineStatus keeps library status online when metadata disconnects after instance is online", () => {
  assert.equal(
    shouldPreserveLibraryOnlineStatus({
      metadataState: "disconnected",
      dependentInstanceState: "online",
    }),
    true,
  );
});

test("shouldPreserveLibraryOnlineStatus does not suppress disconnects when no dependent instance is online", () => {
  assert.equal(
    shouldPreserveLibraryOnlineStatus({
      metadataState: "disconnected",
      dependentInstanceState: "idle",
    }),
    false,
  );
});
