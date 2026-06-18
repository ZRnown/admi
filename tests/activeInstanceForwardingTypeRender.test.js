import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("active instance form renders with the selected account forwarding type", () => {
  assert.match(
    html,
    /const resolvedForwardingType = activeAccount\.forwardingType \|\| currentForwardingType \|\| 'discord-to-discord';/,
  );
  assert.match(
    html,
    /const nextFormHtml = renderAccountForm\(activeAccount, resolvedForwardingType\);/,
  );
});

test("switching between same-shaped instances forces the form container to swap", () => {
  assert.match(
    html,
    /const shouldReplaceForm =\s*configFormEl\.dataset\.activeAccountId !== String\(activeAccount\.id \|\| ''\) \|\|\s*configFormEl\.dataset\.forwardingType !== resolvedForwardingType \|\|\s*configFormEl\.innerHTML !== nextFormHtml;/,
  );
  assert.match(
    html,
    /configFormEl\.dataset\.activeAccountId = String\(activeAccount\.id \|\| ''\);\s*configFormEl\.dataset\.forwardingType = resolvedForwardingType;/,
  );
});

test("switching account updates the global forwarding type from the selected instance", () => {
  assert.match(html, /function switchAccount\(id\) \{/);
  assert.match(
    html,
    /currentForwardingType = activeAccount\.forwardingType \|\| 'discord-to-discord';/,
  );
});
