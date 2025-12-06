import { promises as fs } from "node:fs";
import path from "node:path";

export class FileLogger {
  private dir: string;
  private level: "debug" | "info" | "error";

  constructor(dir: string = path.resolve(process.cwd(), "logs")) {
    this.dir = dir;
    const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
    this.level = (raw === "debug" || raw === "error") ? (raw as any) : "info";
  }

  private async ensureDir() {
    try {
      await fs.mkdir(this.dir, { recursive: true });
    } catch {}
  }

  private getFilePath(date = new Date()) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    const filename = `${yyyy}-${mm}-${dd}.log`;
    return path.join(this.dir, filename);
  }

  private formatLine(level: string, msg: string) {
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
    const zh = level === "INFO" ? "信息" : level === "DEBUG" ? "调试" : "错误";
    return `[${ts}] [${zh}] ${msg}\n`;
  }

  private shouldWrite(level: "INFO" | "DEBUG" | "ERROR"): boolean {
    const order = { DEBUG: 10, INFO: 20, ERROR: 30 } as const;
    const current = this.level === "debug" ? 10 : this.level === "info" ? 20 : 30;
    return order[level] >= current;
  }

  async log(level: "INFO" | "DEBUG" | "ERROR", msg: string) {
    if (!this.shouldWrite(level)) return;
    await this.ensureDir();
    const file = this.getFilePath();
    const line = this.formatLine(level, msg);
    try {
      await fs.appendFile(file, line, "utf-8");
    } catch {}
  }

  info(msg: string) {
    return this.log("INFO", msg);
  }

  debug(msg: string) {
    return this.log("DEBUG", msg);
  }

  error(msg: string) {
    return this.log("ERROR", msg);
  }

  warn(msg: string) {
    return this.log("INFO", `[警告] ${msg}`);
  }
}
