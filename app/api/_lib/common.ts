import { promises as fs } from "fs";
import path from "path";

export const statusFile = path.resolve(process.cwd(), ".data", "status.json");
export const triggerFile = path.resolve(process.cwd(), ".data", "trigger_reload");

export async function readStatus(): Promise<Record<string, { loginState?: string; loginMessage?: string }>> {
  try {
    const buf = await fs.readFile(statusFile, "utf-8");
    return JSON.parse(buf.toString());
  } catch {
    return {};
  }
}

export async function writeStatus(accountId: string, state: string, message?: string) {
  try {
    await fs.mkdir(path.dirname(statusFile), { recursive: true });
    let obj: Record<string, any> = {};
    try {
      const buf = await fs.readFile(statusFile, "utf-8");
      obj = JSON.parse(buf.toString());
    } catch {}
    obj[accountId] = { loginState: state, loginMessage: message || "" };
    await fs.writeFile(statusFile, JSON.stringify(obj, null, 2));
  } catch {}
}

