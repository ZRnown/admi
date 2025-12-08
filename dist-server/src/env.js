"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getEnv = getEnv;
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
function readEnvFile() {
    const envPath = path_1.default.resolve(process.cwd(), ".env");
    const result = {};
    if (!(0, fs_1.existsSync)(envPath)) {
        return result;
    }
    try {
        const content = (0, fs_1.readFileSync)(envPath, "utf-8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#"))
                continue;
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
    }
    catch (e) {
        console.error("读取 .env 文件失败:", e);
    }
    return result;
}
function getEnv() {
    // 每次都重新读取 .env 文件，确保获取最新值
    const envFile = readEnvFile();
    // 优先使用文件中的值，如果没有则使用 process.env（兼容环境变量）
    return {
        DISCORD_TOKEN: envFile.DISCORD_TOKEN || process.env.DISCORD_TOKEN || "",
        PROXY_URL: envFile.PROXY_URL || process.env.PROXY_URL || undefined,
    };
}
//# sourceMappingURL=env.js.map