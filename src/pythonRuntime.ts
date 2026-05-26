import { spawnSync } from "child_process";
import path from "path";

type PythonResolveOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  extraRoots?: string[];
};

function uniqueNonEmpty(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = String(value).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildLocalVenvCandidates(root?: string): string[] {
  if (!root) return [];
  return [
    path.join(root, ".venv", "bin", "python"),
    path.join(root, ".venv", "bin", "python3"),
  ];
}

export function buildPythonCandidates(options: PythonResolveOptions = {}): string[] {
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const extraRoots = Array.isArray(options.extraRoots) ? options.extraRoots : [];

  return uniqueNonEmpty([
    env.PYTHON,
    env.PYTHON_BIN,
    env.PYTHON_EXECUTABLE,
    ...buildLocalVenvCandidates(cwd),
    ...extraRoots.flatMap((root) => buildLocalVenvCandidates(root)),
    "python3.11",
    "python3.10",
    "python3",
    "python",
  ]);
}

function defaultPythonCandidateCheck(candidate: string): boolean {
  const result = spawnSync(candidate, ["-V"], { stdio: "ignore" });
  return !result.error;
}

export function resolvePythonBin(
  options: PythonResolveOptions = {},
  checkCandidate: (candidate: string) => boolean = defaultPythonCandidateCheck,
): string | null {
  for (const candidate of buildPythonCandidates(options)) {
    if (checkCandidate(candidate)) return candidate;
  }
  return null;
}
