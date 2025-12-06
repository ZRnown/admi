"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_selfbot_v13_1 = require("discord.js-selfbot-v13");
const discord_js_1 = require("discord.js");
const fs_1 = require("fs");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const crypto_1 = require("crypto");
const bot_js_1 = require("./bot.js");
const config_js_1 = require("./config.js");
const env_js_1 = require("./env.js");
const senderBot_js_1 = require("./senderBot.js");
const proxy_agent_1 = require("proxy-agent");
const logger_js_1 = require("./logger.js");
const runningAccounts = new Map();
let currentConfig = null;
const statusFile = node_path_1.default.resolve(process.cwd(), ".data", "status.json");
// 记录已经输出过"未配置 token"错误的账号，避免重复日志
const loggedNoTokenAccounts = new Set();
// 记录配置文件的 hash，只在真正变化时才重新读取
let lastConfigHash = null;
let lastConfigMtime = 0;
async function writeStatus(accountId, state, message) {
    try {
        await fs_1.promises.mkdir(node_path_1.default.dirname(statusFile), { recursive: true });
        let obj = {};
        try {
            const buf = await fs_1.promises.readFile(statusFile, "utf-8");
            obj = JSON.parse(buf.toString());
        }
        catch { }
        obj[accountId] = { loginState: state, loginMessage: message || "" };
        await fs_1.promises.writeFile(statusFile, JSON.stringify(obj, null, 2));
    }
    catch { }
}
async function buildSenderBots(account, logger) {
    const env = (0, env_js_1.getEnv)();
    const senderBotsBySource = new Map();
    let defaultSenderBot;
    const prepares = [];
    const webhooks = account.channelWebhooks || {};
    const replacements = account.replacementsDictionary || {};
    const proxy = account.proxyUrl || env.PROXY_URL;
    if (Object.keys(webhooks).length > 0) {
        for (const [channelId, webhookUrl] of Object.entries(webhooks)) {
            const httpAgent = proxy ? new proxy_agent_1.ProxyAgent(proxy) : undefined;
            const sb = new senderBot_js_1.SenderBot({
                replacementsDictionary: replacements,
                webhookUrl,
                httpAgent,
            });
            prepares.push(sb.prepare());
            senderBotsBySource.set(channelId, sb);
            if (!defaultSenderBot)
                defaultSenderBot = sb;
        }
    }
    if (!defaultSenderBot) {
        throw new Error("At least one webhook must be configured via channelWebhooks.");
    }
    await Promise.all(prepares);
    // 移除重复的 webhook 日志输出，只在日志文件中记录一次
    logger.info(`account "${account.name}" senderBots 构建完成，映射频道数=${senderBotsBySource.size}`);
    return { senderBotsBySource, defaultSenderBot: defaultSenderBot };
}
async function startAccount(account, logger) {
    if (!account.loginRequested) {
        await writeStatus(account.id, "idle", "未请求登录");
        return;
    }
    // 立即设置 pending 状态，表示正在登录
    await writeStatus(account.id, "pending", "正在登录...");
    if (!account.token) {
        // 这个错误应该在 reconcileAccounts 中已经处理过了，这里只更新状态
        if (!loggedNoTokenAccounts.has(account.id)) {
            await logger.error(`账号 "${account.name}" 未配置 token，已跳过登录`);
            loggedNoTokenAccounts.add(account.id);
        }
        await writeStatus(account.id, "error", "未配置 Token");
        return;
    }
    // 首先检查是否已经存在运行中的账号
    const existing = runningAccounts.get(account.id);
    if (existing) {
        const isAlreadyLoggedIn = existing.client && existing.client.user;
        const isLoggingIn = existing.client && existing.client.ws && existing.client.ws.readyState === 0;
        // 如果账号已经登录或正在登录中，只更新配置，不重新创建
        if (isAlreadyLoggedIn || isLoggingIn) {
            await logger.info(`账号 "${account.name}" 已经运行${isAlreadyLoggedIn ? "且已登录" : "且正在登录中"}，跳过重复启动，仅更新配置`);
            // 更新配置
            const { senderBotsBySource, defaultSenderBot } = await buildSenderBots(account, logger);
            const legacyConfig = (0, config_js_1.accountToLegacyConfig)(account);
            existing.account = account;
            existing.senderBotsBySource = senderBotsBySource;
            existing.defaultSenderBot = defaultSenderBot;
            existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource);
            if (isAlreadyLoggedIn) {
                await writeStatus(account.id, "online", "登录成功");
            }
            return;
        }
        // 如果账号存在但没有登录，先停止它
        await logger.info(`账号 "${account.name}" 存在但未登录，先停止旧实例`);
        await stopAccount(account.id, logger, false);
    }
    try {
        const { senderBotsBySource, defaultSenderBot } = await buildSenderBots(account, logger);
        const legacyConfig = (0, config_js_1.accountToLegacyConfig)(account);
        let client;
        if (account.type === "bot") {
            client = new discord_js_1.Client({
                intents: [
                    discord_js_1.GatewayIntentBits.Guilds,
                    discord_js_1.GatewayIntentBits.GuildMessages,
                    discord_js_1.GatewayIntentBits.MessageContent,
                    discord_js_1.GatewayIntentBits.DirectMessages,
                ],
                partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message, discord_js_1.Partials.User],
            });
        }
        else {
            client = new discord_js_selfbot_v13_1.Client();
        }
        const bot = new bot_js_1.Bot(client, legacyConfig, defaultSenderBot, senderBotsBySource);
        const runningInfo = {
            account,
            client,
            bot,
            senderBotsBySource,
            defaultSenderBot,
            isManuallyStopped: false,
        };
        runningAccounts.set(account.id, runningInfo);
        // 设置重连处理器
        setupReconnectHandlers(account.id, logger);
        try {
            // 检查是否已经登录，避免重复登录
            if (bot.client.user) {
                await logger.info(`账号 "${account.name}" 已经登录，跳过重复登录`);
                await writeStatus(account.id, "online", "登录成功");
                return;
            }
            // 检查是否正在登录中，避免重复登录
            const ws = bot.client.ws;
            if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
                await logger.info(`账号 "${account.name}" 正在登录中或已连接，跳过重复登录`);
                return;
            }
            // 标记为正在登录，防止重复调用
            await logger.info(`账号 "${account.name}" 开始登录...`);
            await bot.client.login(account.token);
            // 登录成功消息会在 bot.ts 的 ready 事件中输出，这里不再重复输出
            await writeStatus(account.id, "online", "登录成功");
        }
        catch (e) {
            const msg = String(e?.message || e);
            console.error(e);
            await logger.error(`账号 "${account.name}" 登录失败: ${msg}`);
            await writeStatus(account.id, "error", msg.includes("TOKEN_INVALID") ? "Token 无效" : msg);
            // 如果不是 Token 无效的错误，尝试重连
            if (!msg.includes("TOKEN_INVALID")) {
                await reconnectAccount(account.id, logger, 5000);
            }
            else {
                await stopAccount(account.id, logger, false);
            }
        }
    }
    catch (e) {
        await logger.error(`启动账号 "${account.name}" 失败: ${String(e?.message || e)}`);
        await writeStatus(account.id, "error", String(e?.message || e));
    }
}
async function stopAccount(accountId, logger, manual = true) {
    const running = runningAccounts.get(accountId);
    if (!running)
        return;
    // 标记为手动停止
    if (manual) {
        running.isManuallyStopped = true;
    }
    // 清除重连定时器
    if (running.reconnectTimer) {
        clearTimeout(running.reconnectTimer);
        running.reconnectTimer = undefined;
    }
    try {
        if (running.client.destroy) {
            await running.client.destroy();
        }
    }
    catch (e) {
        await logger.error(`停止账号 "${running.account.name}" 时销毁客户端失败: ${String(e?.message || e)}`);
    }
    runningAccounts.delete(accountId);
    await logger.info(`账号 "${running.account.name}" 已停止`);
    await writeStatus(accountId, "stopped", "已停止");
}
// 自动重连函数
async function reconnectAccount(accountId, logger, delay = 5000) {
    const running = runningAccounts.get(accountId);
    if (!running)
        return;
    // 如果手动停止，不重连
    if (running.isManuallyStopped) {
        return;
    }
    // 如果已经有重连定时器在运行，不重复创建
    if (running.reconnectTimer) {
        return;
    }
    // 如果账号不再请求登录，不重连
    const currentConfig = await (0, config_js_1.getMultiConfig)();
    const account = currentConfig.accounts.find(a => a.id === accountId);
    if (!account || !account.loginRequested) {
        await stopAccount(accountId, logger, false);
        return;
    }
    await logger.info(`账号 "${running.account.name}" 将在 ${delay / 1000} 秒后尝试重连...`);
    await writeStatus(accountId, "pending", `连接断开，${delay / 1000} 秒后重连...`);
    running.reconnectTimer = setTimeout(async () => {
        // 清除定时器引用
        const currentRunning = runningAccounts.get(accountId);
        if (currentRunning) {
            currentRunning.reconnectTimer = undefined;
        }
        try {
            // 清理旧的客户端
            try {
                if (running.client.destroy) {
                    await running.client.destroy();
                }
            }
            catch { }
            // 重新创建客户端
            let client;
            if (running.account.type === "bot") {
                client = new discord_js_1.Client({
                    intents: [
                        discord_js_1.GatewayIntentBits.Guilds,
                        discord_js_1.GatewayIntentBits.GuildMessages,
                        discord_js_1.GatewayIntentBits.MessageContent,
                        discord_js_1.GatewayIntentBits.DirectMessages,
                    ],
                    partials: [discord_js_1.Partials.Channel, discord_js_1.Partials.Message, discord_js_1.Partials.User],
                });
            }
            else {
                client = new discord_js_selfbot_v13_1.Client();
            }
            // 重新创建 Bot 实例
            const legacyConfig = (0, config_js_1.accountToLegacyConfig)(running.account);
            const bot = new bot_js_1.Bot(client, legacyConfig, running.defaultSenderBot, running.senderBotsBySource);
            // 更新运行信息
            running.client = client;
            running.bot = bot;
            // 设置断开重连监听
            setupReconnectHandlers(accountId, logger);
            // 尝试登录
            try {
                await client.login(running.account.token);
                await logger.info(`账号 "${running.account.name}" 重连成功`);
                await writeStatus(accountId, "online", "重连成功");
            }
            catch (e) {
                const msg = String(e?.message || e);
                await logger.error(`账号 "${running.account.name}" 重连失败: ${msg}`);
                await writeStatus(accountId, "error", `重连失败: ${msg}`);
                // 如果重连失败，再次尝试（指数退避，最多30秒）
                const nextDelay = Math.min(delay * 2, 30000);
                await reconnectAccount(accountId, logger, nextDelay);
            }
        }
        catch (e) {
            await logger.error(`账号 "${running.account.name}" 重连过程出错: ${String(e?.message || e)}`);
            const nextDelay = Math.min(delay * 2, 30000);
            await reconnectAccount(accountId, logger, nextDelay);
        }
    }, delay);
}
// 设置重连处理器
function setupReconnectHandlers(accountId, logger) {
    const running = runningAccounts.get(accountId);
    if (!running)
        return;
    const client = running.client;
    // 移除旧的事件监听器（如果存在），避免重复添加
    // 使用 accountId 而不是闭包捕获 running，确保总是获取最新的 running 对象
    const disconnectHandler = async () => {
        const currentRunning = runningAccounts.get(accountId);
        if (!currentRunning || currentRunning.isManuallyStopped)
            return;
        await logger.warn(`账号 "${currentRunning.account.name}" 连接断开`);
        await writeStatus(accountId, "error", "连接断开，正在重连...");
        await reconnectAccount(accountId, logger, 5000);
    };
    const shardDisconnectHandler = async () => {
        const currentRunning = runningAccounts.get(accountId);
        if (!currentRunning || currentRunning.isManuallyStopped)
            return;
        await logger.warn(`账号 "${currentRunning.account.name}" shard 断开`);
        await reconnectAccount(accountId, logger, 5000);
    };
    // 移除旧监听器（如果存在）
    client.removeAllListeners("disconnect");
    client.removeAllListeners("shardDisconnect");
    client.removeAllListeners("resume");
    // 添加新的事件监听器
    client.on("disconnect", disconnectHandler);
    client.on?.("shardDisconnect", shardDisconnectHandler);
    // 监听 resume 事件（重连成功）
    client.on("resume", async () => {
        const currentRunning = runningAccounts.get(accountId);
        if (currentRunning) {
            await logger.info(`账号 "${currentRunning.account.name}" 连接已恢复`);
            await writeStatus(accountId, "online", "连接已恢复");
        }
    });
}
async function reconcileAccounts(newConfig, logger) {
    const oldIds = new Set(runningAccounts.keys());
    const newIds = new Set(newConfig.accounts.map((a) => a.id));
    // 停掉被移除的账号（配置变化导致的停止，不是手动停止）
    for (const id of oldIds) {
        if (!newIds.has(id)) {
            await stopAccount(id, logger, false); // 配置变化导致的停止
        }
    }
    // 新增或更新账号
    for (const account of newConfig.accounts) {
        // 如果账号请求登录但没有 token，跳过处理避免重复错误日志
        if (account.loginRequested && !account.token) {
            const existing = runningAccounts.get(account.id);
            if (!existing && !loggedNoTokenAccounts.has(account.id)) {
                // 只记录一次错误，避免重复日志
                await logger.error(`账号 "${account.name}" 未配置 token，已跳过登录`);
                await writeStatus(account.id, "error", "未配置 Token");
                loggedNoTokenAccounts.add(account.id);
            }
            else if (existing) {
                // 如果账号之前有 token 但现在没有了，需要停止（配置变化导致的停止）
                await stopAccount(account.id, logger, false);
                loggedNoTokenAccounts.add(account.id);
            }
            continue;
        }
        // 如果账号有 token 了，从错误记录中移除
        if (account.token && loggedNoTokenAccounts.has(account.id)) {
            loggedNoTokenAccounts.delete(account.id);
        }
        const existing = runningAccounts.get(account.id);
        if (!existing) {
            // 新账号，直接启动
            await startAccount(account, logger);
            continue;
        }
        const tokenChanged = account.token !== existing.account.token;
        const typeChanged = account.type !== existing.account.type;
        const oldAccount = currentConfig?.accounts.find((a) => a.id === account.id) || existing.account;
        const mappingsChanged = JSON.stringify(account.channelWebhooks || {}) !== JSON.stringify(oldAccount.channelWebhooks || {}) ||
            JSON.stringify(account.replacementsDictionary || {}) !==
                JSON.stringify(oldAccount.replacementsDictionary || {});
        const keywordsChanged = JSON.stringify(account.blockedKeywords || []) !== JSON.stringify(oldAccount.blockedKeywords || []) ||
            JSON.stringify(account.excludeKeywords || []) !== JSON.stringify(oldAccount.excludeKeywords || []) ||
            account.showSourceIdentity !== oldAccount.showSourceIdentity;
        const restartRequested = account.restartNonce !== oldAccount.restartNonce;
        // loginRequested 从 false 变为 true 时才认为是登录请求变化
        // loginNonce 的变化不应该触发重启（它只是用于触发登录，不应该在已登录时触发重启）
        const loginRequestedChanged = account.loginRequested !== oldAccount.loginRequested;
        const loginRequestedBecameTrue = !oldAccount.loginRequested && account.loginRequested;
        // 如果账号已经在运行且登录成功，检查是否需要重启
        const isAlreadyLoggedIn = existing.client && existing.client.user;
        // 如果账号已经登录，且没有需要重启的变化，跳过处理
        if (isAlreadyLoggedIn &&
            !tokenChanged &&
            !typeChanged &&
            !mappingsChanged &&
            !keywordsChanged &&
            !restartRequested &&
            !loginRequestedBecameTrue) {
            // 如果是停止请求（loginRequested 从 true 变为 false），需要停止账号（手动停止）
            if (loginRequestedChanged && account.loginRequested === false && existing.account.loginRequested === true) {
                await stopAccount(account.id, logger, true); // 手动停止
            }
            // 其他情况（包括只是 loginNonce 变化），跳过重启
            continue;
        }
        // 如果账号未请求登录，且当前正在运行，需要停止（手动停止）
        if (!account.loginRequested && isAlreadyLoggedIn) {
            await stopAccount(account.id, logger, true); // 手动停止
            continue;
        }
        // 没有任何变化则跳过
        if (!typeChanged && !tokenChanged && !mappingsChanged && !keywordsChanged && !restartRequested && !loginRequestedBecameTrue) {
            continue;
        }
        // 只有在真正需要重启时才重启（配置变化导致的停止，不是手动停止）
        // loginRequestedBecameTrue 表示从 false 变为 true，需要启动账号
        if (typeChanged || tokenChanged || restartRequested || loginRequestedBecameTrue) {
            await stopAccount(account.id, logger, false); // 配置变化导致的停止
            await startAccount(account, logger);
            continue;
        }
        let senderBotsBySource = existing.senderBotsBySource;
        let defaultSenderBot = existing.defaultSenderBot;
        if (mappingsChanged) {
            const built = await buildSenderBots(account, logger);
            senderBotsBySource = built.senderBotsBySource;
            defaultSenderBot = built.defaultSenderBot;
        }
        const legacyConfig = (0, config_js_1.accountToLegacyConfig)(account);
        existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource);
        existing.account = account;
        existing.senderBotsBySource = senderBotsBySource;
        existing.defaultSenderBot = defaultSenderBot;
        if (keywordsChanged || mappingsChanged) {
            await logger.info(`账号 "${account.name}" 配置已热更新`);
        }
    }
    currentConfig = newConfig;
}
async function main() {
    const logger = new logger_js_1.FileLogger();
    // 在启动时先确保文件存在。这是唯一一次允许创建默认文件的机会。
    // 之后的热重载只负责读取，不会创建文件，避免在原子保存间隙时覆盖配置
    await (0, config_js_1.ensureConfigFile)();
    const multi = await (0, config_js_1.getMultiConfig)();
    currentConfig = multi;
    // 只启动已请求登录的账号，不自动登录
    for (const account of multi.accounts) {
        if (account.loginRequested && account.token) {
            await startAccount(account, logger);
        }
        else {
            // 确保未请求登录的账号状态正确
            await writeStatus(account.id, "idle", "未请求登录");
        }
    }
    const cfgPath = node_path_1.default.resolve(process.cwd(), "config.json");
    let pendingReload = null;
    // 检查配置文件是否真的变化了
    const hasConfigChanged = async () => {
        try {
            const stats = (0, node_fs_1.statSync)(cfgPath);
            // 如果修改时间相同，说明文件没有变化
            if (stats.mtimeMs === lastConfigMtime) {
                return false;
            }
            // 读取文件内容并计算 hash
            const content = await fs_1.promises.readFile(cfgPath, "utf-8");
            const hash = (0, crypto_1.createHash)("md5").update(content).digest("hex");
            // 如果 hash 相同，说明内容没有变化
            if (hash === lastConfigHash) {
                lastConfigMtime = stats.mtimeMs; // 更新修改时间，避免下次重复读取
                return false;
            }
            // 文件内容变化了
            lastConfigHash = hash;
            lastConfigMtime = stats.mtimeMs;
            return true;
        }
        catch (e) {
            // 文件不存在或读取失败，返回 false
            return false;
        }
    };
    const scheduleReload = async () => {
        if (pendingReload)
            clearTimeout(pendingReload);
        pendingReload = setTimeout(async () => {
            pendingReload = null;
            try {
                // 检查是否有触发文件（API 直接触发的操作）
                const triggerPath = node_path_1.default.resolve(process.cwd(), ".data", "trigger_reload");
                let shouldReload = false;
                try {
                    await fs_1.promises.access(triggerPath);
                    // 删除触发文件
                    await fs_1.promises.unlink(triggerPath);
                    shouldReload = true;
                }
                catch {
                    // 触发文件不存在，检查配置文件是否变化
                    shouldReload = await hasConfigChanged();
                }
                if (!shouldReload) {
                    return; // 没有变化，跳过处理
                }
                // 读取配置时可能遇到原子保存间隙（文件暂时不存在），需要重试
                let latest = null;
                let retries = 3;
                while (retries > 0 && !latest) {
                    try {
                        latest = await (0, config_js_1.getMultiConfig)();
                    }
                    catch (e) {
                        retries--;
                        if (retries > 0) {
                            // 可能是原子保存间隙，等待一小段时间后重试
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                        else {
                            // 重试失败，记录错误但不中断程序
                            console.error("读取配置文件失败（可能是原子保存间隙）", e);
                            await logger.error(`读取配置文件失败: ${String(e?.message || e)}`);
                            return; // 放弃本次重载，等待下次轮询
                        }
                    }
                }
                if (latest) {
                    await reconcileAccounts(latest, logger);
                }
            }
            catch (e) {
                console.error("自动重载配置失败", e);
                await logger.error(`自动重载配置失败: ${String(e?.message || e)}`);
            }
        }, 100); // 缩短延迟到 100ms，更快响应
    };
    try {
        (0, node_fs_1.watch)(cfgPath, { persistent: true }, scheduleReload);
        await logger.info(`已开始监听配置文件: ${cfgPath}`);
    }
    catch (e) {
        await logger.error(`无法监听配置文件: ${cfgPath}, 错误: ${String(e?.message || e)}`);
    }
    // 轮询兜底，每 2 秒检查一次触发文件（API 触发的操作）
    setInterval(() => {
        scheduleReload();
    }, 2000);
}
process.on("unhandledRejection", async (reason) => {
    const logger = new logger_js_1.FileLogger();
    await logger.error(String(reason?.stack || reason));
});
process.on("uncaughtException", async (err) => {
    const logger = new logger_js_1.FileLogger();
    await logger.error(String(err?.stack || err));
});
main();
//# sourceMappingURL=index.js.map