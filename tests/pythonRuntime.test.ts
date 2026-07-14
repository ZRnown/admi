import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildPythonCandidates, resolvePythonBin } from "../src/pythonRuntime.ts";

test("resolvePythonBin prefers project .venv before generic system python", () => {
  const cwd = path.join(path.sep, "tmp", "admi-runtime");
  const projectVenv = path.join(cwd, ".venv", "bin", "python");

  const resolved = resolvePythonBin(
    { cwd, env: {}, extraRoots: [] },
    (candidate) => candidate === projectVenv || candidate === "python3",
  );

  assert.equal(resolved, projectVenv);
});

test("resolvePythonBin respects explicit PYTHON_BIN override ahead of project .venv", () => {
  const cwd = path.join(path.sep, "tmp", "admi-runtime");
  const override = path.join(path.sep, "custom", "python");

  const resolved = resolvePythonBin(
    { cwd, env: { PYTHON_BIN: override }, extraRoots: [] },
    (candidate) => candidate === override || candidate === path.join(cwd, ".venv", "bin", "python"),
  );

  assert.equal(resolved, override);
});

test("buildPythonCandidates includes bridge-local .venv before generic python fallback", () => {
  const root = path.join(path.sep, "srv", "admi");
  const bridgeRoot = path.join(root, "discord_bridge");
  const candidates = buildPythonCandidates({
    cwd: root,
    env: {},
    extraRoots: [bridgeRoot],
  });

  const rootVenvIndex = candidates.indexOf(path.join(root, ".venv", "bin", "python"));
  const bridgeVenvIndex = candidates.indexOf(path.join(bridgeRoot, ".venv", "bin", "python"));
  const genericPythonIndex = candidates.indexOf("python3");

  assert.notEqual(rootVenvIndex, -1);
  assert.notEqual(bridgeVenvIndex, -1);
  assert.notEqual(genericPythonIndex, -1);
  assert.ok(rootVenvIndex < genericPythonIndex);
  assert.ok(bridgeVenvIndex < genericPythonIndex);
});

test("buildPythonCandidates includes Windows virtualenv executables", () => {
  const candidates = buildPythonCandidates({ cwd: "C:\\admi", env: {} });

  assert.ok(candidates.includes(path.join("C:\\admi", ".venv", "Scripts", "python.exe")));
});
