import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveBackendRuntimeConfig } = require("../scripts/backendRuntimeConfig.js");

test("resolveBackendRuntimeConfig keeps the legacy single-instance defaults", () => {
  const config = resolveBackendRuntimeConfig({});

  assert.deepEqual(config, {
    ocrPort: 9003,
    enableGlobalPythonCleanup: true,
  });
});

test("resolveBackendRuntimeConfig supports isolated multi-instance overrides", () => {
  const config = resolveBackendRuntimeConfig({
    BACKEND_OCR_PORT: "9004",
    BACKEND_GLOBAL_PYTHON_CLEANUP: "false",
  });

  assert.deepEqual(config, {
    ocrPort: 9004,
    enableGlobalPythonCleanup: false,
  });
});
