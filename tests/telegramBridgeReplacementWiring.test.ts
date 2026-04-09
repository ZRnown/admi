import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const typesSource = readFileSync(new URL("../telegram_bridge/src/telegram_bridge/telegram_types.py", import.meta.url), "utf8");
const forwarderSource = readFileSync(new URL("../telegram_bridge/src/telegram_bridge/forwarder.py", import.meta.url), "utf8");
const converterSource = readFileSync(new URL("../telegram_bridge/src/telegram_bridge/message_converter.py", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("telegram bridge mapping model keeps account id and replacement dictionaries", () => {
  assert.match(typesSource, /account_id: Optional\[str\] = Field\(default=None, alias="accountId"\)/);
  assert.match(
    typesSource,
    /replacements_dictionary: Optional\[Dict\[str, str\]\] = Field\(default=None, alias="replacementsDictionary"\)/,
  );
  assert.match(typesSource, /alias="effectiveReplacementsDictionary"/);
});

test("telegram bridge sync sends merged replacements and effective source identity", () => {
  assert.match(
    indexSource,
    /const effectiveReplacementsDictionary = \{\s*\.\.\.\(account\.replacementsDictionary \|\| \{\}\),\s*\.\.\.\(mapping\.replacementsDictionary \|\| \{\}\),\s*\};/,
  );
});

test("telegram bridge forwarder uses effective replacements per mapping", () => {
  assert.match(
    forwarderSource,
    /effective_replacements = \(\s*getattr\(mapping, "effective_replacements_dictionary", None\)\s*or getattr\(mapping, "replacements_dictionary", None\)\s*or None\s*\)/,
  );
  assert.match(
    forwarderSource,
    /show_source_identity=getattr\(mapping, "show_source_identity", False\)/,
  );
  assert.match(forwarderSource, /mapping\.target_channel_id/);
});

test("telegram message converter also applies replacements to media captions", () => {
  assert.match(
    converterSource,
    /caption = str\(media\["caption"\]\)[\s\S]*caption = caption\.replace\(old_text, new_text\)[\s\S]*text \+= f"\\n\{caption\}"/,
  );
});
