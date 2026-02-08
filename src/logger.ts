export class FileLogger {
  private level: number; // 0: DEBUG, 1: INFO, 2: ERROR

  constructor(_dir?: string) {
    const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
    this.level = raw === "debug" ? 0 : raw === "error" ? 2 : 1;
  }

  private formatLine(level: string, msg: string) {
    const ts = new Date().toISOString().replace("T", " ").replace("Z", "");
    return `[${ts}] [${level}] ${msg}`;
  }

  log(levelName: "INFO" | "DEBUG" | "ERROR", msg: string) {
    const levelVal = levelName === "DEBUG" ? 0 : levelName === "INFO" ? 1 : 2;
    if (levelVal < this.level) return;

    const label = levelName === "DEBUG" ? "调试" : levelName === "INFO" ? "信息" : "错误";
    const line = this.formatLine(label, msg);
    if (levelName === "ERROR") {
      console.error(line);
      return;
    }
    if (levelName === "DEBUG") {
      console.debug(line);
      return;
    }
    console.log(line);
  }

  info(msg: string) {
    this.log("INFO", msg);
  }

  debug(msg: string) {
    this.log("DEBUG", msg);
  }

  error(msg: string) {
    this.log("ERROR", msg);
  }

  warn(msg: string) {
    this.log("INFO", `[警告] ${msg}`);
  }
}
