import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const configSource = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("config normalization preserves rule-level showSourceIdentity for discord and telegram mappings", () => {
  assert.match(
    configSource,
    /replacementsDictionary:\s*typeof m\.replacementsDictionary === 'object' && m\.replacementsDictionary \? m\.replacementsDictionary : \{\},[\s\S]*showSourceIdentity:\s*m\.showSourceIdentity === true \? true : undefined,/,
  );
  assert.match(
    configSource,
    /replacementsDictionary:\s*typeof mapping\.replacementsDictionary === 'object' && mapping\.replacementsDictionary \? mapping\.replacementsDictionary : \{\},[\s\S]*showSourceIdentity:\s*mapping\.showSourceIdentity === true \? true : undefined,/,
  );
});

test("runtime forwarding prefers rule-level showSourceIdentity before global fallback", () => {
  assert.match(
    indexSource,
    /const showSourceIdentity =\s*rule\.showSourceIdentity === true \? true : account\.showSourceIdentity === true;/,
  );
  assert.match(
    indexSource,
    /const effectiveShowSourceIdentity =\s*mapping\.showSourceIdentity === true \? true : account\.showSourceIdentity === true;/,
  );
  assert.match(
    indexSource,
    /telegramMappings\.push\(\{[\s\S]*accountId:\s*account\.id[\s\S]*showSourceIdentity:\s*effectiveShowSourceIdentity[\s\S]*effectiveReplacementsDictionary,/,
  );
  assert.match(
    botSource,
    /const showSourceIdentity =\s*ruleConfig\.showSourceIdentity === true \? true : this\.config\.showSourceIdentity === true;/,
  );
});

test("rule config modal saves showSourceIdentity for telegram mobile client rules", () => {
  assert.match(htmlSource, /showSourceIdentity:\s*false,/);
  assert.match(
    htmlSource,
    /currentRuleConfigType === 'discord-to-telegram' \|\| currentRuleConfigType === 'telegram-to-discord' \|\| currentRuleConfigType === 'telegram-to-telegram' \|\| currentRuleConfigType === 'telegram-to-mobile-client'/,
  );
  assert.match(
    htmlSource,
    /mapping\.showSourceIdentity = document\.getElementById\('ruleShowSourceIdentity'\)\.checked \|\| undefined;/,
  );
});
