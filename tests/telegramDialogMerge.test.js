import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("telegram dialog merge keeps forum metadata when ids change shape", () => {
  assert.match(source, /function normalizeTelegramDialogIdKey\(id: any\)/);
  assert.match(source, /function mergeTelegramDialogEntry\(prev: any, entry: any\)/);
  assert.match(source, /if \(prev\.id && String\(prev\.id\)\.startsWith\("-100"\)\)/);
  assert.match(source, /String\(entry\.type \|\| ""\) === "supergroup"/);
  assert.match(source, /merged\.id = `-100\$\{merged\.id\}`;/);
  assert.match(source, /if \(\(prev\.is_forum === true \|\| prev\.isForum === true \|\| entry\.is_forum === true \|\| entry\.isForum === true\)\)/);
  assert.match(source, /const key = alias \|\| String\(id\);/);
  assert.match(source, /byId\.set\(key, mergeTelegramDialogEntry\(prev, entry\)\);/);
});

test("telegram dialog cache writes merge incoming dialogs with existing cache", () => {
  const writeStart = source.indexOf("async function writeTelegramDialogsCache");
  const writeEnd = source.indexOf("function formatDiscordUserLabel", writeStart);
  assert.ok(writeStart > 0);
  assert.ok(writeEnd > writeStart);
  const writeSource = source.slice(writeStart, writeEnd);

  assert.match(writeSource, /const existing = Array\.isArray\(cache\[accountId\]\) \? cache\[accountId\] : \[\];/);
  assert.match(writeSource, /cache\[accountId\] = mergeTelegramDialogs\(existing, dialogs\);/);
  assert.doesNotMatch(writeSource, /cache\[accountId\] = dialogs;/);
});
