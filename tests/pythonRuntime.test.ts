import test from "node:test";
import assert from "node:assert/strict";

import { buildPythonCandidates, resolvePythonBin } from "../src/pythonRuntime.ts";

test("resolvePythonBin prefers project .venv before generic system python", () => {
  const cwd = "/tmp/admi-runtime";
  const projectVenv = `${cwd}/.venv/bin/python`;

  const resolved = resolvePythonBin(
    { cwd, env: {}, extraRoots: [] },
    (candidate) => candidate === projectVenv || candidate === "python3",
  );

  assert.equal(resolved, projectVenv);
});

test("resolvePythonBin respects explicit PYTHON_BIN override ahead of project .venv", () => {
  const cwd = "/tmp/admi-runtime";
  const override = "/custom/python";

  const resolved = resolvePythonBin(
    { cwd, env: { PYTHON_BIN: override }, extraRoots: [] },
    (candidate) => candidate === override || candidate === `${cwd}/.venv/bin/python`,
  );

  assert.equal(resolved, override);
});

test("buildPythonCandidates includes bridge-local .venv before generic python fallback", () => {
  const candidates = buildPythonCandidates({
    cwd: "/srv/admi",
    env: {},
    extraRoots: ["/srv/admi/discord_bridge"],
  });

  const rootVenvIndex = candidates.indexOf("/srv/admi/.venv/bin/python");
  const bridgeVenvIndex = candidates.indexOf("/srv/admi/discord_bridge/.venv/bin/python");
  const genericPythonIndex = candidates.indexOf("python3");

  assert.notEqual(rootVenvIndex, -1);
  assert.notEqual(bridgeVenvIndex, -1);
  assert.notEqual(genericPythonIndex, -1);
  assert.ok(rootVenvIndex < genericPythonIndex);
  assert.ok(bridgeVenvIndex < genericPythonIndex);
});
