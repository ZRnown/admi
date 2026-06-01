import dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";
import path from "path";
import { resolveProjectRoot } from "./paths";

export interface Env {
  DISCORD_TOKEN: string;
  PROXY_URL?: string;
  ENABLED_FORWARDING_TYPES?: string;
  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;
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

function resolveEnvPath(): string {
  return path.resolve(resolveProjectRoot(), ".env");
}

export function getEnv(): Env {
  // 每次都重新读取 .env 文件，确保获取最新值
  const envFile = readEnvFile();
  
  // 优先使用文件中的值，如果没有则使用 process.env（兼容环境变量）
  return {
    DISCORD_TOKEN: envFile.DISCORD_TOKEN || process.env.DISCORD_TOKEN || "",
    PROXY_URL: envFile.PROXY_URL || process.env.PROXY_URL || undefined,
    ENABLED_FORWARDING_TYPES:
      envFile.ENABLED_FORWARDING_TYPES || process.env.ENABLED_FORWARDING_TYPES || undefined,
    FEISHU_APP_ID: envFile.FEISHU_APP_ID || process.env.FEISHU_APP_ID || undefined,
    FEISHU_APP_SECRET: envFile.FEISHU_APP_SECRET || process.env.FEISHU_APP_SECRET || undefined,
  };
}
