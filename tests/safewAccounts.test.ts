import test from "node:test";
import assert from "node:assert/strict";

import {
  getSafewAccountOptions,
  resolveSafewAccountForRule,
} from "../src/safewAccounts.ts";

test("resolveSafewAccountForRule selects the bot configured on the rule", () => {
  const account: any = {
    safewAccounts: [
      { id: "safe-a", name: "A", botToken: "token-a" },
      { id: "safe-b", name: "B", botToken: "token-b" },
    ],
  };

  const selected = resolveSafewAccountForRule(account, { safewAccountId: "safe-b" });

  assert.deepEqual(selected, {
    id: "safe-b",
    name: "B",
    botToken: "token-b",
  });
});

test("resolveSafewAccountForRule requires an explicit bot selection", () => {
  const account: any = {
    safewAccounts: [
      { id: "safe-a", name: "A", botToken: "token-a" },
      { id: "safe-b", name: "B", botToken: "token-b" },
    ],
  };

  const selected = resolveSafewAccountForRule(account, {});

  assert.equal(selected, undefined);
});

test("legacy SafeW token remains available only when explicitly selected", () => {
  const account: any = {
    safewBotToken: "legacy-token",
  };

  const selected = resolveSafewAccountForRule(account, { safewAccountId: "__legacy_safew__" });

  assert.deepEqual(selected, {
    id: "__legacy_safew__",
    name: "SafeW 机器人",
    botToken: "legacy-token",
  });
});

test("getSafewAccountOptions returns only accounts with usable tokens", () => {
  const options = getSafewAccountOptions({
    safewAccounts: [
      { id: "safe-a", name: "A", botToken: "token-a" },
      { id: "safe-empty", name: "Empty", botToken: "   " },
      { id: "safe-b", name: "B", botToken: "token-b" },
    ],
  } as any);

  assert.deepEqual(options.map((item) => item.id), ["safe-a", "safe-b"]);
});
