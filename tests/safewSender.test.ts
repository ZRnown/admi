import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";

import { SafewSender } from "../src/safewSender.ts";

function installHttpsRequestMock(t: any, responseBody: Record<string, any>, statusCode = 200) {
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
      (res as any).headers = {};
      process.nextTick(() => {
        callback(res);
        res.emit("data", JSON.stringify(responseBody));
        res.emit("end");
      });
    };
    req.destroy = (error?: Error) => {
      if (error) req.emit("error", error);
    };

    return req as any;
  });

  return calls;
}

test("SafewSender sends plain text with reply target", async (t) => {
  const calls = installHttpsRequestMock(t, { ok: true, result: { message_id: 123 } });
  const sender = new SafewSender({
    botToken: "safe-token",
    chatId: "-10042",
    apiBaseUrl: "https://api.safew.example",
  });

  const result = await sender.send({
    content: "hello safew",
    sourceMessageId: "discord-message-1",
    replyToTargetMessageId: "99",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.hostname, "api.safew.example");
  assert.equal(calls[0].options.path, "/botsafe-token/sendmessage");

  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.chat_id, "-10042");
  assert.equal(payload.text, "hello safew");
  assert.equal(payload.reply_to_message_id, 99);
  assert.deepEqual(result, {
    sourceMessageId: "discord-message-1",
    targetMessageId: "123",
    targetChannelId: "-10042",
  });
});

test("SafewSender sends images and videos with captions", async (t) => {
  const calls = installHttpsRequestMock(t, { ok: true, result: { message_id: 456 } });
  const sender = new SafewSender({
    botToken: "safe-token",
    chatId: "-10042",
    apiBaseUrl: "https://api.safew.example",
  });

  await sender.send({
    content: "media caption",
    attachments: [
      { url: "https://cdn.example.com/a.jpg", filename: "a.jpg", isImage: true },
      { url: "https://cdn.example.com/b.mp4", filename: "b.mp4", isVideo: true },
    ],
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.hostname, "cdn.example.com");
  assert.equal(calls[1].options.path, "/botsafe-token/sendphoto");
  assert.equal(calls[2].options.method, "GET");
  assert.equal(calls[2].options.hostname, "cdn.example.com");
  assert.equal(calls[3].options.path, "/botsafe-token/sendvideo");

  assert.match(calls[1].options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  assert.match(calls[1].body, /name="chat_id"\r\n\r\n-10042/);
  assert.match(calls[1].body, /name="caption"\r\n\r\nmedia caption/);
  assert.match(calls[1].body, /name="photo"; filename="a.jpg"/);

  assert.match(calls[3].options.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  assert.match(calls[3].body, /name="video"; filename="b.mp4"/);
  assert.match(calls[3].body, /name="caption"\r\n\r\nmedia caption/);
});

test("SafewSender splits long plain text messages", async (t) => {
  const calls = installHttpsRequestMock(t, { ok: true, result: { message_id: 789 } });
  const sender = new SafewSender({
    botToken: "safe-token",
    chatId: "-10042",
    apiBaseUrl: "https://api.safew.example",
  });

  await sender.send({
    content: "a".repeat(3900) + "\n" + "b".repeat(200),
  });

  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].body).text.length, 3800);
  assert.equal(JSON.parse(calls[1].body).text.length, 301);
});

test("SafewSender keeps media caption short and sends overflow as text", async (t) => {
  const calls = installHttpsRequestMock(t, { ok: true, result: { message_id: 456 } });
  const sender = new SafewSender({
    botToken: "safe-token",
    chatId: "-10042",
    apiBaseUrl: "https://api.safew.example",
  });

  await sender.send({
    content: "x".repeat(950),
    attachments: [{ url: "https://cdn.example.com/a.jpg", filename: "a.jpg", isImage: true }],
  });

  assert.equal(calls.length, 3);
  assert.match(calls[1].body, /name="caption"\r\n\r\n/);
  const captionMatch = calls[1].body.match(/name="caption"\r\n\r\n(.+?)\r\n--/s);
  assert.equal(captionMatch?.[1].length, 900);
  assert.equal(JSON.parse(calls[2].body).text.length, 50);
});
