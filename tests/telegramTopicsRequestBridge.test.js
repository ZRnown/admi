import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routeSource = readFileSync(
  new URL("../app/api/metadata/telegram/topics/route.ts", import.meta.url),
  "utf8",
);
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("telegram topics route delegates to backend request files", () => {
  assert.doesNotMatch(routeSource, /getBridgeClient/);
  assert.match(routeSource, /telegramTopicRequestDir/);
  assert.match(routeSource, /telegramTopicResponseDir/);
  assert.match(routeSource, /waitForTopicResponse\(requestId, 60000\)/);
});

test("backend handles telegram topic requests through the running bridge", () => {
  assert.match(indexSource, /const telegramTopicRequestDir = resolveDataPath\("telegram_topic_requests"\);/);
  assert.match(indexSource, /async function processTelegramTopicRequest\(logger: FileLogger\)/);
  assert.match(indexSource, /getClientForumTopics\(accountId, chatId\)/);
  assert.match(indexSource, /getBotForumTopics\(accountId, chatId\)/);
  assert.match(indexSource, /processTelegramTopicRequest\(logger\)\.catch\(\(\) => \{\}\);/);
});
