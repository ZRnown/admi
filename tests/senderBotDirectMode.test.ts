import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SenderBot } = require("../dist-bot/senderBot.js");

function installHttpsRequestMock(
  t: any,
  responseBody: Record<string, any>,
  statusCode = 200,
) {
  const calls: Array<{ options: any; body: string }> = [];

  t.mock.method(https, "request", (options: any, callback: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: (ms: number, handler?: () => void) => void;
      write: (chunk: string | Buffer) => void;
      end: () => void;
      destroy: (error?: Error) => void;
    };

    let body = "";
    req.setTimeout = (_ms: number, _handler?: () => void) => {};
    req.write = (chunk: string | Buffer) => {
      body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    };
    req.end = () => {
      calls.push({ options, body });
      const res = new EventEmitter() as EventEmitter & { statusCode?: number; statusMessage?: string };
      res.statusCode = statusCode;
      res.statusMessage = statusCode >= 200 && statusCode < 300 ? "OK" : "ERROR";
      process.nextTick(() => {
        callback(res);
        res.emit("data", JSON.stringify(responseBody));
        res.emit("end");
      });
    };
    req.destroy = (error?: Error) => {
      if (error) {
        req.emit("error", error);
      }
    };

    return req as any;
  });

  return calls;
}

test("SenderBot direct mode posts to Discord channel API without webhook identity fields", async (t) => {
  const calls = installHttpsRequestMock(t, { id: "target-msg-1", channel_id: "1234567890" });
  const sender = new SenderBot({
    webhookUrl: "https://discord.com/api/webhooks/1/example",
    targetChannelId: "1234567890",
    authToken: "Bot direct-token",
    authType: "bot",
  });

  const result = await sender.sendData([
    {
      content: "hello relay",
      sourceMessageId: "source-1",
      username: "Source User",
      avatarUrl: "https://example.com/avatar.png",
    },
  ]);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.hostname, "discord.com");
  assert.equal(calls[0].options.path, "/api/v10/channels/1234567890/messages");
  assert.equal(calls[0].options.headers.Authorization, "Bot direct-token");

  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.content, "hello relay");
  assert.equal(payload.username, undefined);
  assert.equal(payload.avatar_url, undefined);
  assert.deepEqual(result, [
    {
      sourceMessageId: "source-1",
      targetMessageId: "target-msg-1",
      targetChannelId: "1234567890",
    },
  ]);
});

test("SenderBot direct mode edits messages with selfbot authorization header", async (t) => {
  const calls = installHttpsRequestMock(t, { id: "target-msg-2", channel_id: "dm-42" });
  const sender = new SenderBot({
    webhookUrl: "https://discord.com/api/webhooks/1/example",
    targetChannelId: "dm-42",
    authToken: "self-user-token",
    authType: "selfbot",
  });

  await sender.editForwardedMessage({
    targetChannelId: "dm-42",
    targetMessageId: "target-msg-2",
    content: "edited relay",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "PATCH");
  assert.equal(calls[0].options.path, "/api/v10/channels/dm-42/messages/target-msg-2");
  assert.equal(calls[0].options.headers.Authorization, "self-user-token");

  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.content, "edited relay");
});

test("SenderBot applies global and rule replacements to embed text payloads", async (t) => {
  const calls = installHttpsRequestMock(t, { id: "target-msg-3", channel_id: "1234567890" });
  const sender = new SenderBot({
    webhookUrl: "https://discord.com/api/webhooks/1/example",
    targetChannelId: "1234567890",
    authToken: "Bot direct-token",
    authType: "bot",
    replacementsDictionary: {
      foo: "bar",
    },
  });

  await sender.sendData([
    {
      content: "",
      extraEmbeds: [
        {
          title: "foo title",
          description: "foo description",
          fields: [{ name: "foo field", value: "foo value" }],
        },
      ],
      ruleReplacementsDictionary: {
        bar: "baz",
      },
    },
  ]);

  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.embeds[0].title, "baz title");
  assert.equal(payload.embeds[0].description, "baz description");
  assert.equal(payload.embeds[0].fields[0].name, "baz field");
  assert.equal(payload.embeds[0].fields[0].value, "baz value");
});

test("SenderBot applies replacements to embed text when editing forwarded messages", async (t) => {
  const calls = installHttpsRequestMock(t, { id: "target-msg-4", channel_id: "dm-42" });
  const sender = new SenderBot({
    webhookUrl: "https://discord.com/api/webhooks/1/example",
    targetChannelId: "dm-42",
    authToken: "self-user-token",
    authType: "selfbot",
    replacementsDictionary: {
      foo: "bar",
    },
  });

  await sender.editForwardedMessage({
    targetChannelId: "dm-42",
    targetMessageId: "target-msg-4",
    content: "",
    extraEmbeds: [
      {
        title: "foo edit",
        description: "foo edit desc",
      },
    ],
    ruleReplacementsDictionary: {
      bar: "baz",
    },
  });

  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.embeds[0].title, "baz edit");
  assert.equal(payload.embeds[0].description, "baz edit desc");
});
