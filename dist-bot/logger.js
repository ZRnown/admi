"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileLogger = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
class FileLogger {
    constructor(dir = node_path_1.default.resolve(process.cwd(), "logs")) {
        this.dir = dir;
        const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
        this.level = (raw === "debug" || raw === "error") ? raw : "info";
    }
    async ensureDir() {
        try {
            await node_fs_1.promises.mkdir(this.dir, { recursive: true });
        }
        catch { }
    }
    getFilePath(date = new Date()) {
        const yyyy = date.getFullYear();
        const mm = String(date.getMonth() + 1).padStart(2, "0");
        const dd = String(date.getDate()).padStart(2, "0");
        const filename = `${yyyy}-${mm}-${dd}.log`;
        return node_path_1.default.join(this.dir, filename);
    }
    formatLine(level, msg) {
        const now = new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}.${String(now.getMilliseconds()).padStart(3, "0")}`;
        const zh = level === "INFO" ? "信息" : level === "DEBUG" ? "调试" : "错误";
        return `[${ts}] [${zh}] ${msg}\n`;
    }
    shouldWrite(level) {
        const order = { DEBUG: 10, INFO: 20, ERROR: 30 };
        const current = this.level === "debug" ? 10 : this.level === "info" ? 20 : 30;
        return order[level] >= current;
    }
    async log(level, msg) {
        if (!this.shouldWrite(level))
            return;
        await this.ensureDir();
        const file = this.getFilePath();
        const line = this.formatLine(level, msg);
        try {
            await node_fs_1.promises.appendFile(file, line, "utf-8");
        }
        catch { }
    }
    info(msg) {
        return this.log("INFO", msg);
    }
    debug(msg) {
        return this.log("DEBUG", msg);
    }
    error(msg) {
        return this.log("ERROR", msg);
    }
    warn(msg) {
        return this.log("INFO", `[警告] ${msg}`);
    }
}
exports.FileLogger = FileLogger;
//# sourceMappingURL=logger.js.map