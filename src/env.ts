import dotenv from "dotenv";
import { readFileSync, existsSync } from "fs";
import path from "path";

export interface Env {
  DISCORD_TOKEN: string;
  PROXY_URL?: string;
}

function readEnvFile(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), ".env");
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

export function getEnv(): Env {
  // 每次都重新读取 .env 文件，确保获取最新值
  const envFile = readEnvFile();
  
  // 优先使用文件中的值，如果没有则使用 process.env（兼容环境变量）
  return {
    DISCORD_TOKEN: envFile.DISCORD_TOKEN || process.env.DISCORD_TOKEN || "",
    PROXY_URL: envFile.PROXY_URL || process.env.PROXY_URL || undefined,
  };
}
