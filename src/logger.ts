import { createWriteStream, WriteStream, mkdirSync } from "node:fs";
import path from "node:path";

export class FileLogger {
  private dir: string;
  private level: number; // 0: DEBUG, 1: INFO, 2: ERROR
  private stream: WriteStream | null = null;
  private currentFileDate: string = "";

  constructor(dir: string = path.resolve(process.cwd(), "logs")) {
    this.dir = dir;
    const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
    this.level = raw === "debug" ? 0 : raw === "error" ? 2 : 1;
    this.ensureDir(); // 同步一次即可，后续不需要每次检查
  }

  private ensureDir() {
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {}
  }

  private getStream(): WriteStream {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const dateKey = `${yyyy}-${mm}-${dd}`;

    // 如果日期变了，或者流不存在，创建新流
    if (dateKey !== this.currentFileDate || !this.stream) {
      if (this.stream) {
        this.stream.end();
      }
      this.currentFileDate = dateKey;
      const filename = `${dateKey}.log`;
      // flags: 'a' 追加模式
      this.stream = createWriteStream(path.join(this.dir, filename), { flags: "a", encoding: "utf-8" });
      
      // 错误处理，防止流错误导致崩溃
      this.stream.on('error', (err) => {
        console.error("Logger Stream Error:", err);
      });
    }
    return this.stream;
  }

  private formatLine(level: string, msg: string) {
    const now = new Date();
    // 简单的ISO时间格式，性能优于手动拼接多次
    const ts = now.toISOString().replace('T', ' ').replace('Z', '');
    return `[${ts}] [${level}] ${msg}\n`;
  }

  log(levelName: "INFO" | "DEBUG" | "ERROR", msg: string) {
    const levelVal = levelName === "DEBUG" ? 0 : levelName === "INFO" ? 1 : 2;
    if (levelVal < this.level) return;

    const stream = this.getStream();
    // 核心优化：write 是非阻塞的，Node.js 会在内部处理缓冲
    stream.write(this.formatLine(levelName === "DEBUG" ? "调试" : levelName === "INFO" ? "信息" : "错误", msg));
  }

  info(msg: string) { this.log("INFO", msg); }
  debug(msg: string) { this.log("DEBUG", msg); }
  error(msg: string) { this.log("ERROR", msg); }
  warn(msg: string) { this.log("INFO", `[警告] ${msg}`); }
}
