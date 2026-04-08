const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const routeSource = readFileSync(
  path.join(__dirname, "..", "app", "api", "config", "route.ts"),
  "utf8",
);

test("config route preserves rule-level showSourceIdentity in both API directions", () => {
  assert.match(routeSource, /interface FrontendMapping[\s\S]*showSourceIdentity\?: boolean;/);
  assert.match(routeSource, /mappings\.push\(\{[\s\S]*showSourceIdentity:\s*savedRule\.showSourceIdentity,/);
  assert.match(routeSource, /savedMappings\.push\(\{[\s\S]*showSourceIdentity:\s*mapping\.showSourceIdentity,/);
});
