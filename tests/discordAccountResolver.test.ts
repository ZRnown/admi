import test from "node:test";
import assert from "node:assert/strict";

import { resolveDiscordSendAccountRef } from "../src/discordAccountResolver.ts";

test("resolveDiscordSendAccountRef falls back from source instance to library discord accounts", () => {
  const resolved = resolveDiscordSendAccountRef(
    {
      accounts: [
        {
          id: "instance-1",
          type: "selfbot",
          token: "instance-token",
        },
      ],
      discordAccounts: [
        {
          id: "library-1",
          type: "bot",
          token: "Bot library-token",
          name: "Relay",
        },
      ],
    } as any,
    {
      id: "instance-1",
      type: "selfbot",
      token: "instance-token",
      name: "Instance",
    } as any,
    "library-1",
  );

  assert.deepEqual(resolved, {
    id: "library-1",
    type: "bot",
    token: "library-token",
    name: "Relay",
  });
});

test("resolveDiscordSendAccountRef uses the source account when sender account id matches the instance", () => {
  const resolved = resolveDiscordSendAccountRef(
    {
      accounts: [],
      discordAccounts: [],
    } as any,
    {
      id: "instance-1",
      type: "selfbot",
      token: "instance-token",
      name: "Instance",
    } as any,
    "instance-1",
  );

  assert.deepEqual(resolved, {
    id: "instance-1",
    type: "selfbot",
    token: "instance-token",
    name: "Instance",
  });
});
