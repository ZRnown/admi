import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../app/api/config/route.ts", import.meta.url), "utf8");
const mappingSource = readFileSync(new URL("../src/mappingNormalization.ts", import.meta.url), "utf8");
const statusPayloadSource = readFileSync(new URL("../src/configStatusPayload.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("tg-only branch locks enabled forwarding types in config", () => {
  assert.match(
    configSource,
    /const FORWARDING_TYPES = \[\s*"telegram-to-telegram",\s*\] as const;/,
  );
  assert.match(
    configSource,
    /const BRANCH_ENABLED_FORWARDING_TYPES: ForwardingType\[\] = \["telegram-to-telegram"\];/,
  );
  assert.match(
    configSource,
    /const DEFAULT_FORWARDING_TYPE: ForwardingType = BRANCH_ENABLED_FORWARDING_TYPES\[0\];/,
  );
  assert.match(
    configSource,
    /const effectiveForwardingTypes = BRANCH_ENABLED_FORWARDING_TYPES;/,
  );
});

test("config api normalizes forwarded accounts to tg-only mode", () => {
  assert.match(apiSource, /forwardingType: normalizeBranchForwardingType\(/);
});

test("config api dto types only expose telegram-to-telegram", () => {
  assert.match(apiSource, /forwardingType\?:\s*"telegram-to-telegram";/);
  assert.match(apiSource, /enabledForwardingTypes\?: Array<\s*"telegram-to-telegram"\s*>;/);
});

test("telegram mapping normalization only keeps telegram-to-telegram", () => {
  assert.match(
    mappingSource,
    /let normalizedType: "telegram-to-telegram" = "telegram-to-telegram";/,
  );
  assert.doesNotMatch(mappingSource, /"telegram-to-discord"|"discord-to-telegram"/);
});

test("status payload falls back to telegram-to-telegram", () => {
  assert.match(
    statusPayloadSource,
    /forwardingType: account\.forwardingType \|\| "telegram-to-telegram",/,
  );
});

test("tg-only library filtering keeps only telegram accounts for telegram-to-telegram", () => {
  assert.match(
    html,
    /else if \(type === 'telegram-to-telegram'\) {\s*allowed\.add\('telegram'\);\s*}/,
  );
  assert.doesNotMatch(
    html,
    /else if \(type === 'telegram-to-telegram'\) {\s*allowed\.add\('telegram'\);\s*allowed\.add\('discord'\);\s*}/,
  );
});

test("tg-only account form renders forwarding type as a locked value instead of a multi-option selector", () => {
  assert.match(html, /function getSingleEnabledForwardingType\(\)/);
  assert.match(
    html,
    /const singleEnabledForwardingType = getSingleEnabledForwardingType\(\);[\s\S]*?singleEnabledForwardingType \? `[\s\S]*?Telegram → Telegram[\s\S]*?disabled/,
  );
});

test("account library edit modal builds type options from the allowed kinds", () => {
  assert.match(html, /const allowedKinds = getAllowedLibraryKinds\(\);/);
  assert.match(
    html,
    /const typeOptions = allowedKinds\.map\(\(kind\) => `\<option value="\$\{kind\}"/,
  );
});

test("front-end no longer exposes non-telegram forwarding labels", () => {
  assert.doesNotMatch(
    html,
    /Discord → Discord|Discord → Telegram|Telegram → Discord|Discord → 飞书|Discord → 钉钉|X → Discord|TruthSocial → Discord/,
  );
});
