import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { EventEmitter } from "node:events";

import { DingTalkSender } from "../src/dingtalkSender.ts";

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

test("DingTalkSender preserves button links after long Discord content", async (t) => {
  const calls = installHttpsRequestMock(t, { errcode: 0 });
  const sender = new DingTalkSender("https://oapi.dingtalk.com/robot/send?access_token=test-token");

  await sender.send({
    content: `${"长正文".repeat(1500)}\nText: https://example.com/text\nHTML: https://example.com/html`,
  });

  assert.ok(calls.length > 1);
  const joinedMarkdown = calls
    .map((call) => JSON.parse(call.body).markdown.text)
    .join("\n");
  assert.match(joinedMarkdown, /Text: https:\/\/example\.com\/text/);
  assert.match(joinedMarkdown, /HTML: https:\/\/example\.com\/html/);
  for (const call of calls) {
    const text = JSON.parse(call.body).markdown.text;
    assert.ok(text.length <= 3800);
  }
});
