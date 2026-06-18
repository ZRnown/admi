import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/telegramBridgeClient.ts", import.meta.url), "utf8");

test("telegram bridge client gives login and channel sync requests a longer timeout", () => {
  assert.match(source, /const DEFAULT_REQUEST_TIMEOUT_MS = 30000;/);
  assert.match(source, /const LONG_RUNNING_REQUEST_TIMEOUT_MS = 65000;/);
  assert.match(source, /"startClientLogin"/);
  assert.match(source, /"confirmClientLogin"/);
  assert.match(source, /"connectClient"/);
  assert.match(source, /"connectBot"/);
  assert.match(source, /"getClientChannels"/);
  assert.match(source, /"getBotChannels"/);
  assert.match(source, /"getClientForumTopics"/);
  assert.match(source, /"getBotForumTopics"/);
  assert.match(source, /const timeoutMs = this\._getRequestTimeoutMs\(method\);/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /}, timeoutMs\);/);
});
