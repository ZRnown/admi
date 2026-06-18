import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
      const res = new EventEmitter() as EventEmitter & {
        statusCode?: number;
        statusMessage?: string;
        headers?: Record<string, string>;
      };
      res.statusCode = statusCode;
      res.statusMessage = statusCode >= 200 && statusCode < 300 ? "OK" : "ERROR";
      res.headers = {
        "content-length": String(Buffer.byteLength(JSON.stringify(responseBody))),
        "content-type": "application/json",
      };
      process.nextTick(() => {
        callback(res);
        res.emit("data", Buffer.from(JSON.stringify(responseBody)));
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

test("SenderBot sends upload once and splits long overflow text", async (t) => {
  const calls = installHttpsRequestMock(t, { id: "target-msg-long", channel_id: "1234567890" });
  const sender = new SenderBot({
    webhookUrl: "https://discord.com/api/webhooks/1/example",
  });

  await sender.sendData([
    {
      content: "a".repeat(2500),
      sourceMessageId: "source-long",
      uploads: [
        {
          url: "https://cdn.example.com/chart.jpg",
          filename: "chart.jpg",
          isImage: true,
        },
      ],
    },
  ]);

  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.path, "/api/webhooks/1/example?wait=true");
  assert.equal(calls[2].options.path, "/api/webhooks/1/example?wait=true");

  const firstPayloadMatch = calls[1].body.match(/name="payload_json"\r\nContent-Type: application\/json\r\n\r\n(.+?)\r\n--/s);
  assert.ok(firstPayloadMatch?.[1]);
  const firstPayload = JSON.parse(firstPayloadMatch[1]);
  assert.equal(firstPayload.content.length, 2000);
  assert.equal(firstPayload.attachments.length, 1);

  const secondPayload = JSON.parse(calls[2].body);
  assert.equal(secondPayload.content.length, 500);
  assert.equal(secondPayload.attachments, undefined);
});

test("SenderBot sends message with oversized upload as link instead of failing", async (t) => {
  const calls = installHttpsRequestMock(t, { id: "target-msg-large", channel_id: "1234567890" });
  const tempDir = path.join(os.tmpdir(), `sender-large-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const largeFile = path.join(tempDir, "large-video.mp4");
  await writeFile(largeFile, Buffer.alloc(16 * 1024 * 1024));

  const sender = new SenderBot({
    webhookUrl: "https://discord.com/api/webhooks/1/example",
  });

  const result = await sender.sendData([
    {
      content: "正文应该继续发送",
      sourceMessageId: "source-large",
      uploads: [
        {
          localPath: largeFile,
          url: "https://cdn.example.com/large-video.mp4",
          filename: "large-video.mp4",
          isVideo: true,
        },
      ],
    },
  ]);

  assert.equal(calls.length, 1);
  assert.deepEqual(result, [
    {
      sourceMessageId: "source-large",
      targetMessageId: "target-msg-large",
      targetChannelId: "1234567890",
    },
  ]);
  const payload = JSON.parse(calls[0].body);
  assert.match(payload.content, /正文应该继续发送/);
  assert.match(payload.content, /附件过大，已改为链接/);
  assert.match(payload.content, /large-video\.mp4/);
  assert.match(payload.content, /https:\/\/cdn\.example\.com\/large-video\.mp4/);
});

test("SenderBot deletes forwarded messages via direct channel API", async (t) => {
  const calls = installHttpsRequestMock(t, {}, 204);
  const sender = new SenderBot({
    webhookUrl: "https://discord.com/api/webhooks/1/example",
    targetChannelId: "dm-42",
    authToken: "self-user-token",
    authType: "selfbot",
  });

  await sender.deleteForwardedMessage({
    targetChannelId: "dm-42",
    targetMessageId: "target-msg-delete",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].options.path, "/api/v10/channels/dm-42/messages/target-msg-delete");
  assert.equal(calls[0].options.headers.Authorization, "self-user-token");
});
