import test from "node:test";
import assert from "node:assert/strict";
import { buildConfigStatusPayload } from "../src/configStatusPayload.ts";

test("buildConfigStatusPayload strips heavy rule collections from poll responses", () => {
  const payload = buildConfigStatusPayload({
    config: {
      accounts: [
        {
          id: "acc-1",
          forwardingType: "discord-to-discord",
          loginRequested: true,
          botRelays: [
            { id: "relay-1", name: "Relay 1", token: "secret" },
          ],
          telegramConfig: {
            accounts: [
              { id: "tg-1", enabled: true, type: "client" },
            ],
            mappings: [
              { id: "rule-a", type: "discord-to-telegram", sourceChannelId: "1", targetChannelId: "2" },
            ],
          },
          mappings: [
            { id: "rule-b", sourceChannelId: "10", targetWebhookUrl: "https://example.com" },
          ],
        },
      ],
      discordAccounts: [
        { id: "discord-lib-1", name: "Discord A", token: "discord-token" },
      ],
      telegramAccounts: [
        { id: "tg-lib-1", name: "Telegram A", token: "tg-token" },
      ],
      xAccounts: [],
      truthSocialAccounts: [],
      activeId: "acc-1",
      loginUser: "admin",
      loginPassword: "secret",
    } as any,
    runtimeStatusByAccountId: {
      "acc-1": {
        loginState: "online",
        loginMessage: "running",
        telegramBotState: "idle",
        telegramClientState: "online",
        botRelays: [
          { id: "relay-1", loginState: "online", loginMessage: "ready" },
        ],
      },
    },
    discordLibraryStatusById: {
      "discord-lib-1": {
        loginState: "online",
        loginMessage: "ready",
        guildsCount: 12,
        channelsCount: 120,
      },
    },
    telegramStatusById: {
      "tg-1": { state: "online", message: "connected" },
      "tg-lib-1": { state: "online", message: "connected", userInfo: { username: "demo" } },
    },
    externalForwardStatusByKind: {
      x: { "acc-1": { "rule-x": { lastPollAt: 123 } } },
      truthsocial: {},
    },
  });

  assert.deepEqual(payload.accounts, [
    {
      id: "acc-1",
      forwardingType: "discord-to-discord",
      loginRequested: true,
      loginState: "online",
      loginMessage: "running",
      telegramBotState: "idle",
      telegramBotMessage: "未连接",
      telegramClientState: "online",
      telegramClientMessage: "connected",
      telegramAccountStates: {
        "tg-1": {
          state: "online",
          message: "connected",
          userInfo: undefined,
        },
      },
      botRelays: [
        {
          id: "relay-1",
          loginState: "online",
          loginMessage: "ready",
        },
      ],
      telegramConfig: {
        accounts: [
          { id: "tg-1", enabled: true },
        ],
      },
      externalForwardStatus: {
        x: { "rule-x": { lastPollAt: 123 } },
        truthsocial: undefined,
      },
    },
  ]);

  assert.deepEqual(payload.discordAccounts, [
    {
      id: "discord-lib-1",
      name: "Discord A",
      loginEnabled: undefined,
      loginState: "online",
      loginMessage: "ready",
      syncedUser: undefined,
      guildsCount: 12,
      channelsCount: 120,
      lastSyncTime: undefined,
    },
  ]);

  assert.deepEqual(payload.telegramAccounts, [
    {
      id: "tg-lib-1",
      name: "Telegram A",
      enabled: undefined,
      loginState: "online",
      loginMessage: "connected",
      userInfo: { username: "demo" },
    },
  ]);
});
