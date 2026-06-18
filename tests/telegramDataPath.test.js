import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const telegramRouteFiles = [
  "app/api/metadata/telegram/sync/route.ts",
  "app/api/metadata/telegram/dialogs/route.ts",
  "app/api/telegram/client/connect/route.ts",
  "app/api/telegram/client/status/route.ts",
  "app/api/telegram/client/disconnect/route.ts",
  "app/api/telegram/login/start/route.ts",
  "app/api/telegram/login/confirm/route.ts",
  "app/api/telegram/client/session-file/route.ts",
  "app/api/telegram/bot/connect/route.ts",
  "app/api/telegram/avatar/[filename]/route.ts",
  "app/api/telegram/media/[filename]/route.ts",
  "app/api/metadata/telegram/topics/route.ts",
];

test("telegram API routes use the shared project data directory", () => {
  for (const file of telegramRouteFiles) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /resolveDataPath/, `${file} should import/use resolveDataPath`);
    assert.doesNotMatch(
      source,
      /process\.cwd\(\),\s*["']\.data["']/,
      `${file} should not resolve .data from the standalone cwd`,
    );
  }
});
