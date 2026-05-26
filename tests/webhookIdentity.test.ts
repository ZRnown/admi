import test from "node:test";
import assert from "node:assert/strict";

import { buildWebhookAssetUrl, resolveWebhookIdentity } from "../src/webhookIdentity.ts";

test("resolveWebhookIdentity prefers target webhook overrides", () => {
  assert.deepEqual(
    resolveWebhookIdentity("Source Name", "https://source/avatar.png", "Target Name", "https://target/avatar.png"),
    { username: "Target Name", avatarUrl: "https://target/avatar.png" },
  );
});

test("resolveWebhookIdentity falls back to source identity when overrides are empty", () => {
  assert.deepEqual(
    resolveWebhookIdentity("Source Name", "https://source/avatar.png", "", ""),
    { username: "Source Name", avatarUrl: "https://source/avatar.png" },
  );
});

test("buildWebhookAssetUrl prefers publicBaseUrl over request origin", () => {
  assert.equal(
    buildWebhookAssetUrl("https://example.com/base", "http://127.0.0.1:3011/api/webhook-avatar/upload", "avatar.png"),
    "https://example.com/api/webhook-avatar/avatar.png",
  );
});
