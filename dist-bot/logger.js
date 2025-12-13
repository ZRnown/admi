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
        this.stream = null;
        this.currentFileDate = "";
        this.dir = dir;
        const raw = (process.env.LOG_LEVEL || "info").toLowerCase();
        this.level = raw === "debug" ? 0 : raw === "error" ? 2 : 1;
        this.ensureDir(); // 同步一次即可，后续不需要每次检查
    }
    ensureDir() {
        try {
            (0, node_fs_1.mkdirSync)(this.dir, { recursive: true });
        }
        catch { }
    }
    getStream() {
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
            this.stream = (0, node_fs_1.createWriteStream)(node_path_1.default.join(this.dir, filename), { flags: "a", encoding: "utf-8" });
            // 错误处理，防止流错误导致崩溃
            this.stream.on('error', (err) => {
                console.error("Logger Stream Error:", err);
            });
        }
        return this.stream;
    }
    formatLine(level, msg) {
        const now = new Date();
        // 简单的ISO时间格式，性能优于手动拼接多次
        const ts = now.toISOString().replace('T', ' ').replace('Z', '');
        return `[${ts}] [${level}] ${msg}\n`;
    }
    log(levelName, msg) {
        const levelVal = levelName === "DEBUG" ? 0 : levelName === "INFO" ? 1 : 2;
        if (levelVal < this.level)
            return;
        const stream = this.getStream();
        // 核心优化：write 是非阻塞的，Node.js 会在内部处理缓冲
        stream.write(this.formatLine(levelName === "DEBUG" ? "调试" : levelName === "INFO" ? "信息" : "错误", msg));
    }
    info(msg) { this.log("INFO", msg); }
    debug(msg) { this.log("DEBUG", msg); }
    error(msg) { this.log("ERROR", msg); }
    warn(msg) { this.log("INFO", `[警告] ${msg}`); }
}
exports.FileLogger = FileLogger;
//# sourceMappingURL=logger.js.map