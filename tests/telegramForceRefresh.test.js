import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const syncRouteSource = readFileSync(
  new URL("../app/api/metadata/telegram/sync/route.ts", import.meta.url),
  "utf8",
);
const uiSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("telegram sync supports forcing a fresh dialog refresh instead of returning cache", () => {
  assert.match(syncRouteSource, /forceRefresh/);
  assert.match(syncRouteSource, /if \(!forceRefresh && \(cachedBeforeRequest\.length > 0 \|\| userInfoBeforeRequest\)\)/);
});

test("manual telegram account sync requests a fresh dialog refresh", () => {
  assert.match(uiSource, /syncTelegramAccountDataOnly\(accountId,\s*\{\s*forceRefresh:\s*true\s*\}\)/);
  assert.match(uiSource, /forceRefresh:\s*options\.forceRefresh === true/);
});
