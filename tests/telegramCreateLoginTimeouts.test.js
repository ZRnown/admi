import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const uiSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const loginStartRouteSource = readFileSync(
  new URL("../app/api/telegram/login/start/route.ts", import.meta.url),
  "utf8",
);
const loginConfirmRouteSource = readFileSync(
  new URL("../app/api/telegram/login/confirm/route.ts", import.meta.url),
  "utf8",
);

function extractNumber(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return Number(match[1]);
}

function extractOffset(source, pattern, label) {
  const match = source.match(pattern);
  assert.ok(match, `missing ${label}`);
  return Number(match[1]);
}

test("telegram create flow waits longer than backend login routes and uses explicit timeout errors", () => {
  const backendStartWaitMs = extractNumber(
    loginStartRouteSource,
    /waitForLoginResponse\(requestId,\s*(\d+)\)/,
    "backend start login wait",
  );
  const backendConfirmWaitMs = extractNumber(
    loginConfirmRouteSource,
    /waitForLoginResponse\(requestId,\s*(\d+)\)/,
    "backend confirm login wait",
  );
  const frontendBaseWaitMs = extractNumber(
    uiSource,
    /const TELEGRAM_LOGIN_ROUTE_WAIT_MS = (\d+);/,
    "frontend telegram login route wait",
  );
  const frontendStartOffsetMs = extractOffset(
    uiSource,
    /const TELEGRAM_CREATE_LOGIN_START_TIMEOUT_MS = TELEGRAM_LOGIN_ROUTE_WAIT_MS \+ (\d+);/,
    "frontend create start timeout offset",
  );
  const frontendConfirmOffsetMs = extractOffset(
    uiSource,
    /const TELEGRAM_CREATE_LOGIN_CONFIRM_TIMEOUT_MS = TELEGRAM_LOGIN_ROUTE_WAIT_MS \+ (\d+);/,
    "frontend create confirm timeout offset",
  );
  const frontendStartWaitMs = frontendBaseWaitMs + frontendStartOffsetMs;
  const frontendConfirmWaitMs = frontendBaseWaitMs + frontendConfirmOffsetMs;

  assert.ok(
    frontendStartWaitMs > backendStartWaitMs,
    `frontend start timeout ${frontendStartWaitMs} should exceed backend wait ${backendStartWaitMs}`,
  );
  assert.ok(
    frontendConfirmWaitMs > backendConfirmWaitMs,
    `frontend confirm timeout ${frontendConfirmWaitMs} should exceed backend wait ${backendConfirmWaitMs}`,
  );
  assert.match(uiSource, /controller\.abort\(new Error\(message\)\)/);
  assert.match(uiSource, /发送验证码超时，请稍后重试/);
  assert.match(uiSource, /Telegram 登录确认超时，请稍后重试/);
});

test("telegram login errors distinguish bridge method issues from telegram not found replies", () => {
  assert.match(uiSource, /function formatTelegramLoginError\(/);
  assert.match(uiSource, /Telegram Bridge 方法不存在，请重启后台服务后再试/);
  assert.match(uiSource, /验证码会话已失效，请重新发送验证码后再确认/);
  assert.match(uiSource, /Telegram 返回未找到，请检查手机号、API ID、API Hash 和代理配置后重新发送验证码/);
  assert.match(uiSource, /\^\(Telegram Bridge 方法不存在\|验证码会话已失效\|Telegram 返回未找到\)/);
  assert.match(uiSource, /not\\s\*fou\?n\?t/i);
  assert.match(uiSource, /formatTelegramLoginError\(e\?\.message \|\| e\)/);
});

test("telegram library login reads current form values before sending code", () => {
  assert.match(uiSource, /id="tg-phone-\$\{account\.id\}"/);
  assert.match(uiSource, /id="tg-api-id-\$\{account\.id\}"/);
  assert.match(uiSource, /document\.getElementById\(`tg-phone-\$\{accountId\}`\)\?\.value\?\.trim\(\)/);
  assert.match(uiSource, /await saveConfigImmediate\(\);[\s\S]*fetch\('\/api\/telegram\/login\/start'/);
  assert.match(uiSource, /phoneNumber,\s*apiId,\s*apiHash,/);
});

test("telegram create login reads current form values before sending code", () => {
  assert.match(uiSource, /function startTelegramCreateLogin\(\)/);
  assert.match(uiSource, /document\.getElementById\('createTelegramPhone'\)\?\.value\?\.trim\(\)/);
  assert.match(uiSource, /document\.getElementById\('createTelegramApiId'\)\?\.value/);
  assert.match(uiSource, /document\.getElementById\('createTelegramApiHash'\)\?\.value\?\.trim\(\)/);
  assert.match(uiSource, /const numericApiId = Number\(apiId\);/);
  assert.match(uiSource, /apiId: numericApiId,/);
  assert.match(uiSource, /await saveConfigImmediate\(\);[\s\S]*fetchWithTimeout\('\/api\/telegram\/login\/start'/);
});

test("telegram login start route writes redacted debug records", () => {
  assert.match(loginStartRouteSource, /telegram_login_debug\.jsonl/);
  assert.match(loginStartRouteSource, /function appendLoginDebug/);
  assert.match(loginStartRouteSource, /phoneSuffix: phoneNumber\.slice\(-4\)/);
  assert.match(loginStartRouteSource, /apiHashLength: apiHash\.length/);
  assert.match(loginStartRouteSource, /apiHashLength: apiHash\.length/);
  assert.doesNotMatch(loginStartRouteSource, /apiHash:\s*apiHash(?!Length)/);
});
