import { readFile, writeFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { getEnv } from "./env";

export type ChannelId = number | string;
export type ChatId = ChannelId;

// Telegram相关类型定义
export interface TelegramAccountConfig {
  id: string;
  name: string;
  type: 'client' | 'bot';  // client = 用户客户端, bot = 机器人
  token: string;           // Bot Token 或 API Hash (client)
  sessionPath?: string;    // Session文件路径 (仅client)
  sessionString?: string;  // Session字符串 (仅client, 加密存储)
  apiId?: number;          // API ID (仅client)
  apiHash?: string;        // API Hash (仅client)
  proxyUrl?: string;
  loginRequested?: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  enabled?: boolean;
}

export interface TelegramMapping {
  id: string;
  sourceChannelId: string;     // 源频道ID
  targetChannelId: string;     // 目标频道ID
  type: 'telegram-to-discord' | 'discord-to-telegram';
  note?: string;
  translate?: boolean;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
  longMessage?: {
    enabled: boolean;
    threshold?: number;
    appendMessage?: string;
  };
}

export interface FrontendTelegramAccount {
  id: string;
  name: string;
  type: 'client' | 'bot';
  token: string;
  sessionPath?: string;
  sessionString?: string;
  apiId?: number;
  apiHash?: string;
  loginRequested?: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  enabled?: boolean;
}

export interface FrontendTelegramMapping {
  id: string;
  sourceChannelId: string;
  targetChannelId: string;
  type: 'telegram-to-discord' | 'discord-to-telegram';
  note?: string;
  translate?: boolean;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
}

export interface FrontendTelegramConfig {
  accounts: FrontendTelegramAccount[];
  mappings: FrontendTelegramMapping[];
  enableTelegramForward?: boolean;
}

export interface ChannelConfig {
  muted: ChannelId[];
  allowed: ChannelId[];
}

// 规则级别的完整配置（适用于所有转发类型）
export interface RuleLevelConfig {
  // 用户过滤
  allowedUsersIds?: ChannelId[];
  mutedUsersIds?: ChannelId[];
  // 关键词触发（至少命中一个才转发）
  blockedKeywords?: string[];
  // 屏蔽关键词（命中则不转发）
  excludeKeywords?: string[];
  // OCR 屏蔽关键词
  ocrBlockedKeywords?: string[];
  // 关键词替换 { 原词: 替换词 }
  replacementsDictionary?: Record<string, string>;
}

// Discord→Discord 规则映射（支持规则级别的完整配置）
export interface DiscordMappingRule extends RuleLevelConfig {
  id: string;
  sourceChannelId: string;
  targetWebhookUrl: string;
  note?: string;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
}

export type FeishuTargetMode = "webhook" | "thread";

export interface FeishuTargetConfig {
  mode: FeishuTargetMode;
  webhookUrl?: string;
  threadId?: string;
}

export type FeishuTargetMap = Record<string, FeishuTargetConfig | string>;

/**
 * 旧版（单账号）配置结构。仅用于向后兼容读取旧的 config.json。
 */
export interface LegacyConfig {
  // 映射：源频道ID -> 目标Webhook URL（一对一）
  channelWebhooks?: Record<string, string>;
  // 映射：源频道ID -> 飞书 Webhook URL
  channelFeishuWebhooks?: FeishuTargetMap;
  // 是否启用飞书转发
  enableFeishuForward?: boolean;
  // 是否启用 Discord 转发
  enableDiscordForward?: boolean;
  // 飞书企业自建应用 AppID / Secret（可选，优先于环境变量）
  feishuAppId?: string;
  feishuAppSecret?: string;
  // 每个频道的备注，仅用于管理界面展示
  channelNotes?: Record<string, string>;
  mutedGuildsIds?: ChannelId[];
  allowedGuildsIds?: ChannelId[];
  mutedChannelsIds?: ChannelId[];
  allowedChannelsIds?: ChannelId[];
  allowedUsersIds?: ChannelId[];
  mutedUsersIds?: ChannelId[];
  channelConfigs?: Record<string, ChannelConfig>;
  blockedKeywords?: string[];
  // 需要从内容中“排除”的关键词（会被删除，而不是整条消息屏蔽）
  excludeKeywords?: string[];
  // 是否在目标中伪装为源用户头像和昵称
  showSourceIdentity?: boolean;
  // 对外可访问的基础地址（用于 Telegram 头像等资源）
  publicBaseUrl?: string;
  showDate?: boolean;
  showChat?: boolean;
  stackMessages?: boolean;
  showMessageDeletions?: boolean;
  showMessageUpdates?: boolean;
  replacementsDictionary?: Record<string, string>;
  historyScan?: {
    enabled?: boolean;
    limit?: number;
    channels?: string[];
  };
  // 翻译功能配置
  enableTranslation?: boolean;
  deepseekApiKey?: string;
  translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
  translationApiKey?: string;
  translationSecret?: string;
  // 机器人中转配置
  enableBotRelay?: boolean;
  botRelayToken?: string; // 兼容旧版单一中转机器人
  botRelayUseWebhook?: boolean; // 兼容旧版
  botRelayLoginState?: string;
  botRelayLoginMessage?: string;
  // 新版多中转机器人
  botRelays?: Array<{
    id: string;
    name: string;
    token: string;
    loginState?: string;
    loginMessage?: string;
  }>;
  channelRelayMap?: Record<string, string>; // 源频道 -> relay id
  // 忽略选项
  ignoreSelf?: boolean;
  ignoreBot?: boolean;
  ignoreImages?: boolean;
  ignoreAudio?: boolean;
  ignoreVideo?: boolean;
  ignoreDocuments?: boolean;
  // Discord -> Discord 转发样式：style1 = 当前内嵌样式；style2 = 纯文本样式（带时间等）
  feishuStyle?: "style1" | "style2";
  // OCR 图片检测服务器URL
  ocrServerUrl?: string;
  // OCR 屏蔽关键词（检测到这些词的图片不会转发）
  ocrBlockedKeywords?: string[];
  // 每个来源频道是否启用翻译（true = 开启翻译；未设置则回退到全局 enableTranslation）
  channelTranslate?: Record<string, boolean>;
  // 每个来源频道的翻译方向配置 (off = 关闭翻译, auto = 自动检测, zh-en = 中译英, en-zh = 英译中)
  channelTranslateDirection?: Record<string, "off" | "auto" | "zh-en" | "en-zh">;
  // 每个来源频道的超长消息配置
  channelLongMessage?: Record<string, { enabled: boolean; threshold?: number; appendMessage?: string }>;
  // Telegram 溢出消息配置
  enableTelegramOverflow?: boolean;
  telegramOverflowThreshold?: number;
  telegramOverflowMessage?: string;
  // Telegram 配置（账号和映射）
  telegramConfig?: {
    accounts: TelegramAccountConfig[];
    mappings: TelegramMapping[];
    enableTelegramForward?: boolean;
  };
  // Telegram 长消息处理配置（全局默认）
  telegramLongMessage?: {
    enabled: boolean;
    threshold?: number;
    appendMessage?: string;
  };
  // 转发类型
  forwardingType?: 'discord-to-discord' | 'discord-to-telegram' | 'telegram-to-discord' | 'discord-to-feishu';
  // Discord→Discord 规则列表（带规则级别用户过滤）
  mappings?: DiscordMappingRule[];
}

export interface AccountConfig extends LegacyConfig {
  id: string;
  name: string;
  /**
   * 账号类型：bot = 机器人 Token，selfbot = 用户（自用号）Token
   */
  type: "bot" | "selfbot";
  token: string;
  proxyUrl?: string;
  channelFeishuWebhooks?: Record<string, FeishuTargetConfig>;
  restartNonce?: number;
  /**
   * 前端显式点击登录后置为 true；仅 loginRequested=true 的账号会实际登录
   */
  loginRequested?: boolean;
  /**
   * 点击"登录"按钮时递增，用于触发对应账号的重启/重登
   */
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  // OCR配置
  enableOCR?: boolean;
  ocrServerUrl?: string;
  ocrBlockedKeywords?: string[];
  // Telegram认证配置（用于Discord→Telegram）
  telegramBotToken?: string;
  // Telegram Client配置（用于Telegram→Discord）
  telegramApiId?: number;
  telegramApiHash?: string;
  telegramSessionPath?: string;
  telegramSessionString?: string;
  sessionType?: "file" | "string";
  // Telegram 配置（账号和映射）
  telegramConfig?: {
    accounts: TelegramAccountConfig[];
    mappings: TelegramMapping[];
    enableTelegramForward?: boolean;
  };
  // Telegram 长消息处理配置（全局默认）
  telegramLongMessage?: {
    enabled: boolean;
    threshold?: number;
    appendMessage?: string;
  };
}

export interface MultiConfig {
  accounts: AccountConfig[];
  activeId?: string;
  // 管理面板登录用户名/密码（可选）
  loginUser?: string;
  loginPassword?: string;
  telegramAvatarBaseUrl?: string;
  // 配置版本，用于迁移
  version?: string;
  // 启用的转发类型（如果不设置，默认全部启用）
  enabledForwardingTypes?: Array<"discord-to-discord" | "discord-to-telegram" | "telegram-to-discord" | "discord-to-feishu">;
}

function createDefaultAccount(): AccountConfig {
  const env = getEnv();
  return {
    id: randomUUID(),
    name: "默认账号",
    type: "selfbot",
    token: env.DISCORD_TOKEN || "",
    proxyUrl: env.PROXY_URL,
    loginRequested: false,
    loginNonce: undefined,
    loginState: "idle",
    loginMessage: "",
    enableBotRelay: false,
    enableDiscordForward: true,
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
    enableFeishuForward: false,
    channelFeishuWebhooks: {},
    feishuAppId: undefined,
    feishuAppSecret: undefined,
  ocrServerUrl: "http://localhost:9003",
  ocrBlockedKeywords: [],
    botRelays: [],
    channelRelayMap: {},
    feishuStyle: "style1",
    channelTranslate: {},
    channelTranslateDirection: {},
  };
}

// 当前配置版本
export const CONFIG_VERSION = "1.1.0"; // 添加Telegram支持

// 导出 ensureConfigFile 供程序启动时调用，而不是在每次读取时调用
// 这样可以避免在原子保存间隙时误判文件不存在而覆盖配置
export async function ensureConfigFile() {
  if (!existsSync("./config.json")) {
    const defaultAccount = createDefaultAccount();
    const multi: MultiConfig = {
      accounts: [defaultAccount],
      activeId: defaultAccount.id,
      loginUser: "admin",
      loginPassword: "admin123",
      version: CONFIG_VERSION
    };
    await writeFile("./config.json", JSON.stringify(multi, null, 2) + "\n");
    console.log("Created default config.json");
  }
}

// 修改：readRawConfig 不再负责创建文件
// 如果文件不存在或读取失败，抛出错误让上层处理（可能是在原子保存间隙，需要重试）
async function readRawConfig(): Promise<any> {
  // 删除 await ensureConfigFile(); 
  // 绝对不要在读取时创建文件，这会导致在原子保存间隙时覆盖用户配置
  
  try {
    const buf = await readFile("./config.json");
    return JSON.parse(buf.toString());
  } catch (e) {
    // 如果读取失败（例如文件正在写入中），抛出错误让上层处理
    // 上层应该进行重试，而不是在这里写入默认配置
    throw e;
  }
}

function normalizeFeishuTarget(raw: any): FeishuTargetConfig | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return { mode: "webhook", webhookUrl: trimmed };
  }
  if (!raw || typeof raw !== "object") return null;
  const mode: FeishuTargetMode = raw.mode === "thread" ? "thread" : "webhook";
  if (mode === "thread") {
    const threadId = typeof raw.threadId === "string" ? raw.threadId.trim() : "";
    if (!threadId) return null;
    return { mode: "thread", threadId };
  }
  const webhookUrl = typeof raw.webhookUrl === "string" ? raw.webhookUrl.trim() : "";
  if (!webhookUrl) return null;
  return { mode: "webhook", webhookUrl };
}

function normalizeAccount(input: any, fallbackName = "未命名账号"): AccountConfig {
  const id = typeof input?.id === "string" && input.id.length > 0 ? input.id : randomUUID();
  const name = typeof input?.name === "string" && input.name.trim() ? input.name.trim() : fallbackName;
  const type: "bot" | "selfbot" = input?.type === "bot" ? "bot" : "selfbot";
  const token = typeof input?.token === "string" ? input.token : "";
  const proxyUrl = typeof input?.proxyUrl === "string" && input.proxyUrl.trim() ? input.proxyUrl.trim() : undefined;
  const replacementsDict: Record<string, string> =
    input?.replacementsDictionary && typeof input.replacementsDictionary === "object"
      ? input.replacementsDictionary
      : {};
  const channelFeishuWebhooks: Record<string, FeishuTargetConfig> = {};
  if (input?.channelFeishuWebhooks && typeof input.channelFeishuWebhooks === "object") {
    for (const [sourceId, rawTarget] of Object.entries(input.channelFeishuWebhooks)) {
      const normalized = normalizeFeishuTarget(rawTarget);
      if (normalized) {
        channelFeishuWebhooks[sourceId] = normalized;
      }
    }
  }

  // 兼容旧版单个 botRelayToken，升级为 botRelays
  let botRelays: AccountConfig["botRelays"] = Array.isArray(input?.botRelays)
    ? input.botRelays
        .filter((x: any) => x && typeof x.token === "string" && x.token.trim())
        .map((x: any) => ({
          id: typeof x.id === "string" && x.id.trim() ? x.id.trim() : randomUUID(),
          name: typeof x.name === "string" && x.name.trim() ? x.name.trim() : "中转机器人",
          token: x.token.trim(),
          loginState: typeof x.loginState === "string" ? x.loginState : "idle",
          loginMessage: typeof x.loginMessage === "string" ? x.loginMessage : "",
        }))
    : undefined;
  if ((!botRelays || botRelays.length === 0) && typeof input?.botRelayToken === "string" && input.botRelayToken.trim()) {
    botRelays = [
      {
        id: randomUUID(),
        name: "中转机器人",
        token: input.botRelayToken.trim(),
        loginState: typeof input?.botRelayLoginState === "string" ? input.botRelayLoginState : "idle",
        loginMessage: typeof input?.botRelayLoginMessage === "string" ? input.botRelayLoginMessage : "",
      },
    ];
  }
  const channelRelayMap: Record<string, string> =
    input?.channelRelayMap && typeof input.channelRelayMap === "object" ? input.channelRelayMap : {};

  const feishuStyle: "style1" | "style2" =
    input?.feishuStyle === "style2" ? "style2" : "style1";
  const channelTranslate: Record<string, boolean> =
    input?.channelTranslate && typeof input.channelTranslate === "object" ? input.channelTranslate : {};
  const channelTranslateDirection: Record<string, "off" | "auto" | "zh-en" | "en-zh"> =
    input?.channelTranslateDirection && typeof input.channelTranslateDirection === "object" ? input.channelTranslateDirection : {};
  const sessionType: "file" | "string" = input?.sessionType === "string" ? "string" : "file";

  // 处理Telegram配置
  const telegramConfig: FrontendTelegramConfig | undefined = input?.telegramConfig && typeof input.telegramConfig === "object" ? {
    accounts: Array.isArray(input.telegramConfig.accounts) ? input.telegramConfig.accounts.map((acc: any) => ({
      id: typeof acc.id === "string" ? acc.id : randomUUID(),
      name: typeof acc.name === "string" ? acc.name : "Telegram Account",
      type: acc.type === "bot" ? "bot" : "client",
      token: typeof acc.token === "string" ? acc.token : "",
      sessionPath: typeof acc.sessionPath === "string" ? acc.sessionPath : undefined,
      sessionString: typeof acc.sessionString === "string" ? acc.sessionString : undefined,
      apiId: typeof acc.apiId === "number" ? acc.apiId : undefined,
      apiHash: typeof acc.apiHash === "string" ? acc.apiHash : undefined,
      loginRequested: acc.loginRequested === true,
      loginNonce: typeof acc.loginNonce === "number" ? acc.loginNonce : undefined,
      loginState: typeof acc.loginState === "string" ? acc.loginState : "idle",
      loginMessage: typeof acc.loginMessage === "string" ? acc.loginMessage : "",
      enabled: acc.enabled === true
    })) : [],
    mappings: Array.isArray(input.telegramConfig.mappings)
      ? input.telegramConfig.mappings.map((mapping: any) => {
          const rawTarget = typeof mapping.targetChannelId === "string" ? mapping.targetChannelId.trim() : "";
          const targetIsWebhook = /^https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(rawTarget);
          const rawType = mapping.type === "discord-to-telegram" ? "discord-to-telegram" : "telegram-to-discord";
          const normalizedType = targetIsWebhook ? "telegram-to-discord" : rawType;

          return {
            id: typeof mapping.id === "string" ? mapping.id : randomUUID(),
            sourceChannelId: typeof mapping.sourceChannelId === "string" ? mapping.sourceChannelId : "",
            targetChannelId: rawTarget,
            type: normalizedType,
            note: typeof mapping.note === "string" ? mapping.note : undefined,
            translate: mapping.translate === true,
            translateDirection: ["off", "auto", "zh-en", "en-zh"].includes(mapping.translateDirection) ? mapping.translateDirection : "auto",
            // Telegram特有的超长消息处理（规则级别）
            longMessage: mapping.longMessage && typeof mapping.longMessage === "object" ? {
              enabled: mapping.longMessage.enabled === true,
              threshold: typeof mapping.longMessage.threshold === "number" ? mapping.longMessage.threshold : undefined,
              appendMessage: typeof mapping.longMessage.appendMessage === "string" ? mapping.longMessage.appendMessage : undefined
            } : undefined
          };
        })
      : [],
    enableTelegramForward: input.telegramConfig.enableTelegramForward === true
  } : undefined;

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
    channelFeishuWebhooks,
    enableFeishuForward: input?.enableFeishuForward === true,
    enableDiscordForward: input?.enableDiscordForward !== false,
    feishuAppId: typeof input?.feishuAppId === "string" && input.feishuAppId.trim() ? input.feishuAppId.trim() : undefined,
    feishuAppSecret: typeof input?.feishuAppSecret === "string" && input.feishuAppSecret.trim() ? input.feishuAppSecret.trim() : undefined,
    channelNotes: input?.channelNotes || {},
    blockedKeywords: Array.isArray(input?.blockedKeywords) ? input.blockedKeywords : [],
    excludeKeywords: Array.isArray(input?.excludeKeywords) ? input.excludeKeywords : [],
    showSourceIdentity: input?.showSourceIdentity === true,
    publicBaseUrl:
      typeof input?.publicBaseUrl === "string" && input.publicBaseUrl.trim()
        ? input.publicBaseUrl.trim()
        : undefined,
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
    botRelayUseWebhook: input?.botRelayUseWebhook === true, // 兼容旧字段
    botRelayLoginState: typeof input?.botRelayLoginState === "string" ? input.botRelayLoginState : "idle",
    botRelayLoginMessage: typeof input?.botRelayLoginMessage === "string" ? input.botRelayLoginMessage : "",
    botRelays,
    channelRelayMap,
    ignoreSelf: input?.ignoreSelf === true,
    ignoreBot: input?.ignoreBot === true,
    ignoreImages: input?.ignoreImages === true,
    ignoreAudio: input?.ignoreAudio === true,
    ignoreVideo: input?.ignoreVideo === true,
    ignoreDocuments: input?.ignoreDocuments === true,
  ocrServerUrl: typeof input?.ocrServerUrl === "string" && input.ocrServerUrl.trim() ? input.ocrServerUrl.trim() : "http://localhost:9003",
  ocrBlockedKeywords: Array.isArray(input?.ocrBlockedKeywords) ? input.ocrBlockedKeywords : [],

  // --- 修复：添加 Telegram 相关顶层字段 ---
  telegramBotToken: typeof input?.telegramBotToken === "string" ? input.telegramBotToken.trim() : undefined,
  telegramApiId: typeof input?.telegramApiId === "number" ? input.telegramApiId : (typeof input?.telegramApiId === "string" && !isNaN(Number(input.telegramApiId)) ? Number(input.telegramApiId) : undefined),
  telegramApiHash: typeof input?.telegramApiHash === "string" ? input.telegramApiHash.trim() : undefined,
  telegramSessionPath: typeof input?.telegramSessionPath === "string" ? input.telegramSessionPath.trim() : undefined,
    telegramSessionString: typeof input?.telegramSessionString === "string" ? input.telegramSessionString.trim() : undefined,
    sessionType,
  // --- 修复结束 ---

  // Telegram转发增强配置（全局默认设置）
  telegramLongMessage: input?.telegramLongMessage && typeof input.telegramLongMessage === "object" ? {
    enabled: input.telegramLongMessage.enabled === true,
    threshold: typeof input.telegramLongMessage.threshold === "number" ? input.telegramLongMessage.threshold : undefined,
    appendMessage: typeof input.telegramLongMessage.appendMessage === "string" ? input.telegramLongMessage.appendMessage : undefined
  } : undefined,
  telegramOverflowThreshold: typeof input?.telegramOverflowThreshold === "number" ? input.telegramOverflowThreshold : undefined,
  telegramOverflowMessage: typeof input?.telegramOverflowMessage === "string" ? input.telegramOverflowMessage : undefined,
    feishuStyle,
    channelTranslate,
    channelTranslateDirection,
    telegramConfig,
    forwardingType: ['discord-to-discord', 'discord-to-telegram', 'telegram-to-discord', 'discord-to-feishu'].includes(input?.forwardingType)
      ? input.forwardingType
      : 'discord-to-discord',
  };
}

function migrateLegacyToMulti(raw: any): MultiConfig {
  const legacy = raw as LegacyConfig;
  const account = normalizeAccount({ ...legacy, token: getEnv().DISCORD_TOKEN || "" }, "默认账号");
  // 如果没有设置登录账密，使用默认值
  const loginUser = (raw as any)?.loginUser || "admin";
  const loginPassword = (raw as any)?.loginPassword || "admin123";
  const telegramAvatarBaseUrl =
    typeof raw?.telegramAvatarBaseUrl === "string" && raw.telegramAvatarBaseUrl.trim()
      ? raw.telegramAvatarBaseUrl.trim()
      : undefined;
  return {
    accounts: [account],
    activeId: account.id,
    loginUser,
    loginPassword,
    telegramAvatarBaseUrl,
  };
}

export async function getMultiConfig(): Promise<MultiConfig> {
  const raw = await readRawConfig();
  if (Array.isArray(raw?.accounts)) {
    const accounts = raw.accounts.map((acc: any, idx: number) =>
      normalizeAccount(acc, idx === 0 ? "默认账号" : `账号${idx + 1}`),
    );
    const active = typeof raw.activeId === "string" ? raw.activeId : accounts[0]?.id;
    // 如果没有设置登录账密，使用默认值
    const loginUser = (raw as any)?.loginUser || "admin";
    const loginPassword = (raw as any)?.loginPassword || "admin123";
    const version = typeof raw.version === "string" ? raw.version : "1.0.0";
    const telegramAvatarBaseUrl =
      typeof raw?.telegramAvatarBaseUrl === "string" && raw.telegramAvatarBaseUrl.trim()
        ? raw.telegramAvatarBaseUrl.trim()
        : undefined;

    // 迁移配置到最新版本
    const migratedAccounts = migrateAccountsToLatest(accounts, version);
    const config = {
      accounts: migratedAccounts,
      activeId: active,
      loginUser,
      loginPassword,
      telegramAvatarBaseUrl,
      version: CONFIG_VERSION,
    };

    // 如果版本有更新，保存配置
    if (version !== CONFIG_VERSION) {
      await saveMultiConfig(config);
      console.log(`Migrated config from version ${version} to ${CONFIG_VERSION}`);
    }

    return config;
  }
  return migrateLegacyToMulti(raw);
}

export async function saveMultiConfig(config: MultiConfig) {
  const payload = JSON.stringify(config, null, 2) + "\n";
  const tmpPath = `./config.json.tmp-${randomUUID()}`;
  await writeFile(tmpPath, payload);
  await rename(tmpPath, "./config.json");
}

export type Config = LegacyConfig;

export function accountToLegacyConfig(account?: AccountConfig): LegacyConfig {
  if (!account) {
    return {
      channelWebhooks: {},
      channelFeishuWebhooks: {},
      enableFeishuForward: false,
      enableDiscordForward: true,
      feishuAppId: undefined,
      feishuAppSecret: undefined,
      channelNotes: {},
      blockedKeywords: [],
      excludeKeywords: [],
      showSourceIdentity: false,
      publicBaseUrl: undefined,
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
      enableTelegramOverflow: false,
    translationProvider: "deepseek",
    translationApiKey: undefined,
    translationSecret: undefined,
    enableBotRelay: false,
    botRelays: [],
    channelRelayMap: {},
    ignoreSelf: false,
    ignoreBot: false,
    ignoreImages: false,
    ignoreAudio: false,
    ignoreVideo: false,
      ignoreDocuments: false,
      feishuStyle: "style1",
      channelTranslate: {},
      channelTranslateDirection: {},
    };
  }
  return {
    channelWebhooks: account.channelWebhooks,
    channelFeishuWebhooks: account.channelFeishuWebhooks,
    enableFeishuForward: account.enableFeishuForward,
    enableDiscordForward: account.enableDiscordForward,
    feishuAppId: account.feishuAppId,
    feishuAppSecret: account.feishuAppSecret,
    channelNotes: account.channelNotes,
    blockedKeywords: account.blockedKeywords,
    excludeKeywords: account.excludeKeywords,
    showSourceIdentity: account.showSourceIdentity,
    publicBaseUrl: account.publicBaseUrl,
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
    botRelays: account.botRelays,
    channelRelayMap: account.channelRelayMap,
    ignoreSelf: account.ignoreSelf,
    ignoreBot: account.ignoreBot,
    ignoreImages: account.ignoreImages,
    ignoreAudio: account.ignoreAudio,
    ignoreVideo: account.ignoreVideo,
    ignoreDocuments: account.ignoreDocuments,
    ocrServerUrl: account.ocrServerUrl,
    ocrBlockedKeywords: account.ocrBlockedKeywords,
    enableTelegramOverflow: (account as any).enableTelegramOverflow,
    telegramOverflowThreshold: (account as any).telegramOverflowThreshold,
    telegramOverflowMessage: (account as any).telegramOverflowMessage,
    feishuStyle: account.feishuStyle,
    channelTranslate: (account as any).channelTranslate || {},
    channelTranslateDirection: (account as any).channelTranslateDirection || {},
    telegramConfig: (account as any).telegramConfig,
  };
}

export async function getConfig(): Promise<LegacyConfig> {
  const multi = await getMultiConfig();
  return accountToLegacyConfig(multi.accounts[0]);
}

/**
 * 将账号配置迁移到最新版本
 */
function migrateAccountsToLatest(accounts: AccountConfig[], fromVersion: string): AccountConfig[] {
  let migratedAccounts = [...accounts];

  // 从1.0.0迁移到1.1.0：添加Telegram支持
  if (compareVersions(fromVersion, "1.1.0") < 0) {
    migratedAccounts = migratedAccounts.map(account => ({
      ...account,
      // 确保telegramConfig字段存在，即使为空
      telegramConfig: account.telegramConfig || {
        accounts: [],
        mappings: [],
        enableTelegramForward: false
      }
    }));
  }

  // 可以在这里添加更多版本迁移逻辑

  return migratedAccounts;
}

/**
 * 比较版本号
 * 返回: -1 (v1 < v2), 0 (v1 == v2), 1 (v1 > v2)
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const part1 = parts1[i] || 0;
    const part2 = parts2[i] || 0;

    if (part1 < part2) return -1;
    if (part1 > part2) return 1;
  }

  return 0;
}
