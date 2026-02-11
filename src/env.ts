import dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";
import path from "path";

export interface Env {
  DISCORD_TOKEN: string;
  PROXY_URL?: string;
  ENABLED_FORWARDING_TYPES?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
  DISPATCH_MODE?: "inline" | "redis";
  REDIS_URL?: string;
  INSTANCE_QUEUE_NAMESPACE?: string;
  DISPATCH_MAX_RETRIES?: number;
  DISPATCH_RETRY_BASE_MS?: number;
  DISPATCH_DLQ_TTL_SEC?: number;
  DISPATCH_DEDUPE_TTL_SEC?: number;
}

function readEnvFile(): Record<string, string> {
  const envPath = resolveEnvPath();
  const result: Record<string, string> = {};
  
  if (!existsSync(envPath)) {
    return result;
  }

  try {
    const content = readFileSync(envPath, "utf-8");
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
      if (match) {
        const key = match[1];
        let value = match[2] || "";
        // 移除引号
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        result[key] = value;
      }
    }
  } catch (e) {
    console.error("读取 .env 文件失败:", e);
  }

  return result;
}


function parsePositiveNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function resolveEnvPath(): string {
  const root = findRepoRoot(process.cwd());
  return path.resolve(root || process.cwd(), ".env");
}

function findRepoRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function getEnv(): Env {
  // 每次都重新读取 .env 文件，确保获取最新值
  const envFile = readEnvFile();
  
  // 优先使用文件中的值，如果没有则使用 process.env（兼容环境变量）
  const dispatchModeRaw = (envFile.DISPATCH_MODE || process.env.DISPATCH_MODE || "inline").toLowerCase();
  const dispatchMode = dispatchModeRaw === "redis" ? "redis" : "inline";

  return {
    DISCORD_TOKEN: envFile.DISCORD_TOKEN || process.env.DISCORD_TOKEN || "",
    PROXY_URL: envFile.PROXY_URL || process.env.PROXY_URL || undefined,
    ENABLED_FORWARDING_TYPES:
      envFile.ENABLED_FORWARDING_TYPES || process.env.ENABLED_FORWARDING_TYPES || undefined,
    FEISHU_APP_ID: envFile.FEISHU_APP_ID || process.env.FEISHU_APP_ID || undefined,
    FEISHU_APP_SECRET: envFile.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET || undefined,
    DISPATCH_MODE: dispatchMode,
    REDIS_URL: envFile.REDIS_URL || process.env.REDIS_URL || undefined,
    INSTANCE_QUEUE_NAMESPACE:
      envFile.INSTANCE_QUEUE_NAMESPACE || process.env.INSTANCE_QUEUE_NAMESPACE || "bridge",
    DISPATCH_MAX_RETRIES: parsePositiveNumber(envFile.DISPATCH_MAX_RETRIES || process.env.DISPATCH_MAX_RETRIES),
    DISPATCH_RETRY_BASE_MS: parsePositiveNumber(
      envFile.DISPATCH_RETRY_BASE_MS || process.env.DISPATCH_RETRY_BASE_MS,
    ),
    DISPATCH_DLQ_TTL_SEC: parsePositiveNumber(envFile.DISPATCH_DLQ_TTL_SEC || process.env.DISPATCH_DLQ_TTL_SEC),
    DISPATCH_DEDUPE_TTL_SEC: parsePositiveNumber(
      envFile.DISPATCH_DEDUPE_TTL_SEC || process.env.DISPATCH_DEDUPE_TTL_SEC,
    ),
  };
}
