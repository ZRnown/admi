"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureConfigFile = ensureConfigFile;
exports.getMultiConfig = getMultiConfig;
exports.saveMultiConfig = saveMultiConfig;
exports.accountToLegacyConfig = accountToLegacyConfig;
exports.getConfig = getConfig;
const promises_1 = require("fs/promises");
const fs_1 = require("fs");
const crypto_1 = require("crypto");
const env_1 = require("./env");
function createDefaultAccount() {
    const env = (0, env_1.getEnv)();
    return {
        id: (0, crypto_1.randomUUID)(),
        name: "默认账号",
        type: "selfbot",
        token: env.DISCORD_TOKEN || "",
        proxyUrl: env.PROXY_URL,
        loginRequested: false,
        loginNonce: undefined,
        loginState: "idle",
        loginMessage: "",
        channelWebhooks: {},
        channelNotes: {},
        blockedKeywords: [],
        excludeKeywords: [],
        showSourceIdentity: false,
        showDate: false,
        showChat: true,
        stackMessages: false,
        showMessageUpdates: false,
        showMessageDeletions: false,
        replacementsDictionary: {},
        historyScan: { enabled: true },
        mutedGuildsIds: [],
        allowedGuildsIds: [],
        mutedChannelsIds: [],
        allowedChannelsIds: [],
        allowedUsersIds: [],
        mutedUsersIds: [],
        channelConfigs: {},
        enableTranslation: false,
        deepseekApiKey: undefined,
    };
}
// 导出 ensureConfigFile 供程序启动时调用，而不是在每次读取时调用
// 这样可以避免在原子保存间隙时误判文件不存在而覆盖配置
async function ensureConfigFile() {
    if (!(0, fs_1.existsSync)("./config.json")) {
        const defaultAccount = createDefaultAccount();
        const multi = { accounts: [defaultAccount], activeId: defaultAccount.id };
        await (0, promises_1.writeFile)("./config.json", JSON.stringify(multi, null, 2) + "\n");
        console.log("Created default config.json");
    }
}
// 修改：readRawConfig 不再负责创建文件
// 如果文件不存在或读取失败，抛出错误让上层处理（可能是在原子保存间隙，需要重试）
async function readRawConfig() {
    // 删除 await ensureConfigFile(); 
    // 绝对不要在读取时创建文件，这会导致在原子保存间隙时覆盖用户配置
    try {
        const buf = await (0, promises_1.readFile)("./config.json");
        return JSON.parse(buf.toString());
    }
    catch (e) {
        // 如果读取失败（例如文件正在写入中），抛出错误让上层处理
        // 上层应该进行重试，而不是在这里写入默认配置
        throw e;
    }
}
function normalizeAccount(input, fallbackName = "未命名账号") {
    const id = typeof input?.id === "string" && input.id.length > 0 ? input.id : (0, crypto_1.randomUUID)();
    const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : fallbackName;
    const type = input?.type === "bot" ? "bot" : "selfbot";
    const token = typeof input?.token === "string" ? input.token : "";
    const proxyUrl = typeof input?.proxyUrl === "string" && input.proxyUrl.trim() ? input.proxyUrl.trim() : undefined;
    const replacementsDict = input?.replacementsDictionary && typeof input.replacementsDictionary === "object"
        ? input.replacementsDictionary
        : {};
    return {
        id,
        name,
        type,
        token,
        proxyUrl,
        loginRequested: input?.loginRequested === true,
        loginNonce: typeof input?.loginNonce === "number" ? input.loginNonce : undefined,
        loginState: typeof input?.loginState === "string" ? input.loginState : "idle",
        loginMessage: typeof input?.loginMessage === "string" ? input.loginMessage : "",
        channelWebhooks: input?.channelWebhooks || {},
        channelNotes: input?.channelNotes || {},
        blockedKeywords: Array.isArray(input?.blockedKeywords) ? input.blockedKeywords : [],
        excludeKeywords: Array.isArray(input?.excludeKeywords) ? input.excludeKeywords : [],
        showSourceIdentity: input?.showSourceIdentity === true,
        showDate: input?.showDate,
        showChat: input?.showChat ?? true,
        stackMessages: input?.stackMessages,
        showMessageDeletions: input?.showMessageDeletions,
        showMessageUpdates: input?.showMessageUpdates,
        replacementsDictionary: replacementsDict,
        historyScan: input?.historyScan,
        mutedGuildsIds: input?.mutedGuildsIds || [],
        allowedGuildsIds: input?.allowedGuildsIds || [],
        mutedChannelsIds: input?.mutedChannelsIds || [],
        allowedChannelsIds: input?.allowedChannelsIds || [],
        allowedUsersIds: input?.allowedUsersIds || [],
        mutedUsersIds: input?.mutedUsersIds || [],
        channelConfigs: input?.channelConfigs || {},
        enableTranslation: input?.enableTranslation === true,
        deepseekApiKey: typeof input?.deepseekApiKey === "string" && input.deepseekApiKey.trim() ? input.deepseekApiKey.trim() : undefined,
        translationProvider: input?.translationProvider || "deepseek",
        translationApiKey: typeof input?.translationApiKey === "string" && input.translationApiKey.trim() ? input.translationApiKey.trim() : undefined,
        translationSecret: typeof input?.translationSecret === "string" && input.translationSecret.trim() ? input.translationSecret.trim() : undefined,
        enableBotRelay: input?.enableBotRelay === true,
        botRelayToken: typeof input?.botRelayToken === "string" && input.botRelayToken.trim() ? input.botRelayToken.trim() : undefined,
        botRelayLoginState: typeof input?.botRelayLoginState === "string" ? input.botRelayLoginState : "idle",
        botRelayLoginMessage: typeof input?.botRelayLoginMessage === "string" ? input.botRelayLoginMessage : "",
        ignoreSelf: input?.ignoreSelf === true,
        ignoreBot: input?.ignoreBot === true,
        ignoreImages: input?.ignoreImages === true,
        ignoreAudio: input?.ignoreAudio === true,
        ignoreVideo: input?.ignoreVideo === true,
        ignoreDocuments: input?.ignoreDocuments === true,
    };
}
function migrateLegacyToMulti(raw) {
    const legacy = raw;
    const account = normalizeAccount({ ...legacy, token: (0, env_1.getEnv)().DISCORD_TOKEN || "" }, "默认账号");
    return { accounts: [account], activeId: account.id };
}
async function getMultiConfig() {
    const raw = await readRawConfig();
    if (Array.isArray(raw?.accounts)) {
        const accounts = raw.accounts.map((acc, idx) => normalizeAccount(acc, idx === 0 ? "默认账号" : `账号${idx + 1}`));
        const active = typeof raw.activeId === "string" ? raw.activeId : accounts[0]?.id;
        return { accounts, activeId: active };
    }
    return migrateLegacyToMulti(raw);
}
async function saveMultiConfig(config) {
    await (0, promises_1.writeFile)("./config.json", JSON.stringify(config, null, 2) + "\n");
}
function accountToLegacyConfig(account) {
    if (!account) {
        return {
            channelWebhooks: {},
            channelNotes: {},
            blockedKeywords: [],
            excludeKeywords: [],
            showSourceIdentity: false,
            replacementsDictionary: {},
            historyScan: { enabled: true },
            mutedGuildsIds: [],
            allowedGuildsIds: [],
            mutedChannelsIds: [],
            allowedChannelsIds: [],
            allowedUsersIds: [],
            mutedUsersIds: [],
            channelConfigs: {},
            showChat: true,
            stackMessages: false,
            showMessageUpdates: false,
            showMessageDeletions: false,
            showDate: false,
            enableTranslation: false,
            deepseekApiKey: undefined,
            translationProvider: "deepseek",
            translationApiKey: undefined,
            translationSecret: undefined,
            enableBotRelay: false,
            botRelayToken: undefined,
            ignoreSelf: false,
            ignoreBot: false,
            ignoreImages: false,
            ignoreAudio: false,
            ignoreVideo: false,
            ignoreDocuments: false,
        };
    }
    return {
        channelWebhooks: account.channelWebhooks,
        channelNotes: account.channelNotes,
        blockedKeywords: account.blockedKeywords,
        excludeKeywords: account.excludeKeywords,
        showSourceIdentity: account.showSourceIdentity,
        showDate: account.showDate,
        showChat: account.showChat,
        stackMessages: account.stackMessages,
        showMessageDeletions: account.showMessageDeletions,
        showMessageUpdates: account.showMessageUpdates,
        replacementsDictionary: account.replacementsDictionary,
        historyScan: account.historyScan,
        mutedGuildsIds: account.mutedGuildsIds,
        allowedGuildsIds: account.allowedGuildsIds,
        mutedChannelsIds: account.mutedChannelsIds,
        allowedChannelsIds: account.allowedChannelsIds,
        allowedUsersIds: account.allowedUsersIds,
        mutedUsersIds: account.mutedUsersIds,
        channelConfigs: account.channelConfigs,
        enableTranslation: account.enableTranslation,
        deepseekApiKey: account.deepseekApiKey,
        translationProvider: account.translationProvider,
        translationApiKey: account.translationApiKey,
        translationSecret: account.translationSecret,
        enableBotRelay: account.enableBotRelay,
        botRelayToken: account.botRelayToken,
        ignoreSelf: account.ignoreSelf,
        ignoreBot: account.ignoreBot,
        ignoreImages: account.ignoreImages,
        ignoreAudio: account.ignoreAudio,
        ignoreVideo: account.ignoreVideo,
        ignoreDocuments: account.ignoreDocuments,
    };
}
async function getConfig() {
    const multi = await getMultiConfig();
    return accountToLegacyConfig(multi.accounts[0]);
}
//# sourceMappingURL=config.js.map