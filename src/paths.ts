import { existsSync } from "fs";
import path from "node:path";

export function resolveProjectRoot(startDir: string = process.cwd()): string {
  const explicitRoot = process.env.APP_ROOT || process.env.PROJECT_ROOT;
  if (explicitRoot) return path.resolve(explicitRoot);

  let current = path.resolve(startDir);
  while (true) {
    if (path.basename(current) === "standalone" && path.basename(path.dirname(current)) === ".next") {
      const candidate = path.resolve(current, "..", "..");
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    }

    const hasPackage = existsSync(path.join(current, "package.json"));
    const looksLikeSourceRoot =
      existsSync(path.join(current, "app")) ||
      existsSync(path.join(current, "src")) ||
      existsSync(path.join(current, "public"));
    if (hasPackage && looksLikeSourceRoot) return current;

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startDir);
    current = parent;
  }
}

export function resolveProjectPath(...parts: string[]): string {
  return path.join(resolveProjectRoot(), ...parts);
}

export function resolveDataPath(...parts: string[]): string {
  return resolveProjectPath(".data", ...parts);
}
