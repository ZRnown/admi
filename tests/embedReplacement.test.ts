import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const embedUtilsSource = readFileSync(new URL("../src/embedUtils.ts", import.meta.url), "utf8");
const botSource = readFileSync(new URL("../src/bot.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("discord to telegram forwarding applies replacement dictionaries to embed text", () => {
  assert.match(embedUtilsSource, /export function applyReplacementDictionaryToEmbeds\(/);
  assert.match(embedUtilsSource, /next\.description = applyReplacementDictionary\(next\.description, dictionary\)/);
  assert.match(embedUtilsSource, /copy\.value = applyReplacementDictionary\(copy\.value, dictionary\)/);
  assert.match(
    botSource,
    /const replacedTelegramEmbeds = applyReplacementDictionaryToEmbeds\([\s\S]*globalReplacementDictionary[\s\S]*ruleReplacementDictionary[\s\S]*\);/,
  );
});

test("telegram to discord forwarding wires replacement dictionaries into the temporary sender", () => {
  assert.match(
    indexSource,
    /const tempSender = new SenderBot\(\{[\s\S]*replacementsDictionary:\s*account\.replacementsDictionary\s*\|\|\s*\{\}[\s\S]*\}\);/,
  );
  assert.match(
    indexSource,
    /await tempSender\.sendData\(\[\{[\s\S]*ruleReplacementsDictionary:\s*rule\.replacementsDictionary[\s\S]*\}\]\);/,
  );
});
