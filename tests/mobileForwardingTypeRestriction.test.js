const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const source = readFileSync(join(__dirname, "../src/config.ts"), "utf8");

test("admin config exposes Discord to DingTalk forwarding by default", () => {
  assert.match(
    source,
    /const DEFAULT_ENABLED_FORWARDING_TYPES: ForwardingType\[\] = \["discord-to-dingtalk"\]/,
  );
  assert.match(source, /function normalizeEnabledForwardingTypesForAdmin\(types\?: ForwardingType\[\]\): ForwardingType\[\]/);
  assert.match(source, /const defaultAllowed = new Set<ForwardingType>\(DEFAULT_ENABLED_FORWARDING_TYPES\)/);
  assert.match(source, /source\.filter\(\(type\) => defaultAllowed\.has\(type\)\)/);
  assert.match(source, /const effectiveForwardingTypes = normalizeEnabledForwardingTypesForAdmin\(envForwardingTypes\)/);
  assert.match(source, /enabledForwardingTypes: effectiveForwardingTypes/);
});

test("legacy instance forwarding types are changed to an allowed default type", () => {
  assert.match(
    source,
    /if \(current && allowedTypes\.includes\(current as ForwardingType\)\) \{\s*return account;\s*\}\s*return \{ \.\.\.account, forwardingType: allowedTypes\[0\] \};/,
  );
  assert.doesNotMatch(
    source,
    /if \(current && FORWARDING_TYPES\.includes\(current as ForwardingType\)\) \{\s*return account;\s*\}/,
  );
});
