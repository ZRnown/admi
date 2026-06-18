import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMobileClientIngestPayload,
  sendMobileClientMessage,
} from "../dist-bot/mobileClientBridge.js";

test("buildMobileClientIngestPayload keeps source identity and media", () => {
  const payload = buildMobileClientIngestPayload({
    source: "telegram",
    categoryId: "tg-main",
    categoryName: "Telegram",
    channelId: "chat-1",
    channelName: "公告频道",
    channelAvatarUrl: "https://example.com/channel-avatar.png",
    messageId: "msg-1",
    author: "海鑫",
    authorId: "tg-user-1",
    authorAvatarUrl: "https://example.com/avatar.png",
    content: "发给客户端的消息",
    createdAt: "2026-06-13T20:00:00+08:00",
    attachments: [{ url: "https://example.com/a.png", filename: "a.png", contentType: "image/png" }],
    reference: {
      messageId: "prev-1",
      author: "上一条用户",
      authorAvatarUrl: "https://example.com/ref.png",
      content: "上一条内容",
    },
  });

  assert.equal(payload.source, "telegram");
  assert.equal(payload.channel_id, "chat-1");
  assert.equal(payload.channel_avatar_url, "https://example.com/channel-avatar.png");
  assert.equal(payload.message.author_avatar_url, "https://example.com/avatar.png");
  assert.equal(payload.message.attachments[0].content_type, "image/png");
  assert.equal(payload.message.reference.author, "上一条用户");
});

test("buildMobileClientIngestPayload drops non-http attachment urls", () => {
  const payload = buildMobileClientIngestPayload({
    source: "telegram",
    channelId: "chat-1",
    messageId: "msg-2",
    attachments: [
      { url: "/tmp/telegram/photo.jpg", filename: "photo.jpg", contentType: "image/jpeg" },
      { url: "file:///tmp/telegram/video.mp4", filename: "video.mp4", contentType: "video/mp4" },
      { url: "https://example.com/ok.png", filename: "ok.png", contentType: "image/png" },
    ],
  });

  assert.deepEqual(payload.message.attachments.map((item) => item.url), ["https://example.com/ok.png"]);
});

test("sendMobileClientMessage posts payload with admin token", async () => {
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ accepted: true, version: 3 }),
      json: async () => ({ accepted: true, version: 3 }),
    };
  };

  const result = await sendMobileClientMessage(
    {
      endpoint: "http://127.0.0.1:8765",
      adminToken: "admin-token",
      payload: buildMobileClientIngestPayload({
        source: "discord",
        channelId: "ch-1",
        channelName: "频道",
        messageId: "m-1",
        author: "zrn0wn",
        content: "hello",
      }),
    },
    fetchImpl,
  );

  assert.deepEqual(result, { accepted: true, version: 3 });
  assert.equal(request.url, "http://127.0.0.1:8765/ingest/message");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-admin-token"], "admin-token");
  assert.match(request.init.body, /"source":"discord"/);
});
