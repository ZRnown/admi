import { readFile, writeFile, rename } from "fs/promises";
import { existsSync } from "fs";
import path from "node:path";
import { randomUUID } from "crypto";
import { getEnv } from "./env";

export type ChannelId = number | string;
export type ChatId = ChannelId;

const CONFIG_PATH = resolveConfigPath();

export function getConfigPath(): string {
  return CONFIG_PATH;
}

const FORWARDING_TYPES = [
  "discord-to-discord",
  "discord-to-telegram",
  "telegram-to-discord",
  "telegram-to-telegram",
  "discord-to-feishu",
] as const;

type ForwardingType = (typeof FORWARDING_TYPES)[number];

function resolveConfigPath(): string {
  if (process.env.CONFIG_PATH) {
    return process.env.CONFIG_PATH;
  }
  const root = findRepoRoot(process.cwd());
  const base = root || process.cwd();
  return path.join(base, "config.json");
}

function findRepoRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

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
  role?: "listener" | "sender";
  sessionType?: "file" | "string";
  loginRequested?: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  enabled?: boolean;
}

export interface TelegramMapping extends RuleLevelConfig {
  id: string;
  sourceChannelId: string;     // 源频道ID
  targetChannelId: string;     // 目标频道ID
  type: 'telegram-to-discord' | 'discord-to-telegram' | 'telegram-to-telegram';
  note?: string;
  translate?: boolean;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
  senderAccountType?: 'bot' | 'client';
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
  role?: "listener" | "sender";
  sessionType?: "file" | "string";
  loginRequested?: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  enabled?: boolean;
}

export interface FrontendTelegramMapping extends RuleLevelConfig {
  id: string;
  sourceChannelId: string;
  targetChannelId: string;
  type: 'telegram-to-discord' | 'discord-to-telegram' | 'telegram-to-telegram';
  note?: string;
  translate?: boolean;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
  senderAccountType?: 'bot' | 'client';
}

export interface FrontendTelegramConfig {
  accounts: FrontendTelegramAccount[];
  mappings: FrontendTelegramMapping[];
  enableTelegramForward?: boolean;
  defaultSenderAccountType?: "bot" | "client";
  listenerAccountType?: "bot" | "client";
}

export interface ChannelConfig {
  muted: ChannelId[];
  allowed: ChannelId[];
}

export type WatermarkPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";

export interface WatermarkConfig {
  enabled?: boolean;
  mode?: "text" | "image" | "both";
  pattern?: "single" | "tile";
  tileGap?: number;
  text?: string;
  textSize?: number;
  textColor?: string;
  textOpacity?: number;
  textAngle?: number;
  fontFamily?: string;
  fontPath?: string;
  imageUrl?: string;
  imageOpacity?: number;
  imageScale?: number;
  position?: WatermarkPosition;
  margin?: number;
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
  // OCR 触发关键词（命中才转发）
  ocrTriggerKeywords?: string[];
  // 超长消息处理（规则级别）
  longMessage?: {
    enabled: boolean;
    threshold?: number;
    appendMessage?: string;
  };
  // 关键词替换 { 原词: 替换词 }
  replacementsDictionary?: Record<string, string>;
  // 使用源用户的昵称和头像（规则级别）
  showSourceIdentity?: boolean;
  // 忽略自己的消息（规则级别）
  ignoreSelf?: boolean;
  // 忽略机器人消息（规则级别）
  ignoreBot?: boolean;
  // 忽略图片（规则级别）
  ignoreImages?: boolean;
  // 忽略音频（规则级别）
  ignoreAudio?: boolean;
  // 忽略视频（规则级别）
  ignoreVideo?: boolean;
  // 忽略文档（规则级别）
  ignoreDocuments?: boolean;
  // 忽略英文/中文（规则级别）
  ignoreEnglish?: boolean;
  ignoreEnglishThreshold?: number;
  ignoreChinese?: boolean;
  ignoreChineseThreshold?: number;
  // 剔除中文/英文字符（规则级别）
  stripEnglish?: boolean;
  stripChinese?: boolean;
  watermark?: WatermarkConfig;
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
  // 关键词是否忽略大小写（默认开启）
  caseInsensitiveKeywords?: boolean;
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
  watermark?: WatermarkConfig;
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
  ignoreEnglish?: boolean;
  ignoreEnglishThreshold?: number;
  ignoreChinese?: boolean;
  ignoreChineseThreshold?: number;
  stripEnglish?: boolean;
  stripChinese?: boolean;
  // Discord -> Discord 转发样式：style1 = 当前内嵌样式；style2 = 纯文本样式（带时间等）
  feishuStyle?: "style1" | "style2";
  // OCR 图片检测服务器URL
  ocrServerUrl?: string;
  // OCR 屏蔽关键词（检测到这些词的图片不会转发）
  ocrBlockedKeywords?: string[];
  // OCR 触发关键词（命中才转发）
  ocrTriggerKeywords?: string[];
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
    defaultSenderAccountType?: "bot" | "client";
    listenerAccountType?: "bot" | "client";
  };
  // Telegram 长消息处理配置（全局默认）
  telegramLongMessage?: {
    enabled: boolean;
    threshold?: number;
    appendMessage?: string;
  };
  // 转发类型
  forwardingType?: ForwardingType;
  // Discord→Discord 规则列表（带规则级别用户过滤）
  mappings?: DiscordMappingRule[];
  // 飞书规则级别过滤配置
  feishuRuleConfigs?: Record<string, RuleLevelConfig>;
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
  feishuRuleConfigs?: Record<string, RuleLevelConfig>;
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
  ocrTriggerKeywords?: string[];
  watermark?: WatermarkConfig;
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
    defaultSenderAccountType?: "bot" | "client";
    listenerAccountType?: "bot" | "client";
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
  enabledForwardingTypes?: ForwardingType[];
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
    caseInsensitiveKeywords: true,
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
    ocrTriggerKeywords: [],
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
  if (!existsSync(CONFIG_PATH)) {
    const defaultAccount = createDefaultAccount();
    const multi: MultiConfig = {
      accounts: [defaultAccount],
      activeId: defaultAccount.id,
      loginUser: "admin",
      loginPassword: "admin123",
      version: CONFIG_VERSION
    };
    await writeFile(CONFIG_PATH, JSON.stringify(multi, null, 2) + "\n");
    console.log(`Created default config.json at ${CONFIG_PATH}`);
  }
}

// 修改：readRawConfig 不再负责创建文件
// 如果文件不存在或读取失败，抛出错误让上层处理（可能是在原子保存间隙，需要重试）
async function readRawConfig(): Promise<any> {
  // 删除 await ensureConfigFile(); 
  // 绝对不要在读取时创建文件，这会导致在原子保存间隙时覆盖用户配置
  
  try {
    const buf = await readFile(CONFIG_PATH);
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

function normalizeWatermarkConfig(raw: any): WatermarkConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const normalizeNumber = (value: any): number | undefined => {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() && !isNaN(Number(value))) {
      return Number(value);
    }
    return undefined;
  };
  const normalizeText = (value: any): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  };
  const normalizePosition = (value: any): WatermarkPosition | undefined => {
    const allowed: WatermarkPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right", "center"];
    return allowed.includes(value as WatermarkPosition) ? (value as WatermarkPosition) : undefined;
  };
  const normalizeMode = (value: any): "text" | "image" | "both" | undefined => {
    if (value === "text" || value === "image" || value === "both") return value;
    return undefined;
  };
  const normalizePattern = (value: any): "single" | "tile" | undefined => {
    if (value === "single" || value === "tile") return value;
    return undefined;
  };

  return {
    enabled: raw.enabled === true,
    mode: normalizeMode(raw.mode),
    pattern: normalizePattern(raw.pattern),
    tileGap: normalizeNumber(raw.tileGap),
    text: normalizeText(raw.text),
    textSize: normalizeNumber(raw.textSize),
    textColor: normalizeText(raw.textColor),
    textOpacity: normalizeNumber(raw.textOpacity),
    textAngle: normalizeNumber(raw.textAngle),
    fontFamily: normalizeText(raw.fontFamily),
    fontPath: normalizeText(raw.fontPath),
    imageUrl: normalizeText(raw.imageUrl),
    imageOpacity: normalizeNumber(raw.imageOpacity),
    imageScale: normalizeNumber(raw.imageScale),
    position: normalizePosition(raw.position),
    margin: normalizeNumber(raw.margin),
  };
}

function normalizeRuleConfig(raw: any): RuleLevelConfig {
  if (!raw || typeof raw !== "object") {
    return {
      allowedUsersIds: [],
      mutedUsersIds: [],
      blockedKeywords: [],
      excludeKeywords: [],
      ocrBlockedKeywords: [],
      ocrTriggerKeywords: [],
      longMessage: undefined,
      replacementsDictionary: {},
      showSourceIdentity: undefined,
      ignoreSelf: undefined,
      ignoreBot: undefined,
      ignoreImages: undefined,
      ignoreAudio: undefined,
      ignoreVideo: undefined,
      ignoreDocuments: undefined,
      ignoreEnglish: undefined,
      ignoreEnglishThreshold: undefined,
      ignoreChinese: undefined,
      ignoreChineseThreshold: undefined,
      stripEnglish: undefined,
      stripChinese: undefined,
      watermark: undefined,
    };
  }
  return {
    allowedUsersIds: Array.isArray(raw.allowedUsersIds) ? raw.allowedUsersIds.map(String).filter(Boolean) : [],
    mutedUsersIds: Array.isArray(raw.mutedUsersIds) ? raw.mutedUsersIds.map(String).filter(Boolean) : [],
    blockedKeywords: Array.isArray(raw.blockedKeywords) ? raw.blockedKeywords.filter(Boolean) : [],
    excludeKeywords: Array.isArray(raw.excludeKeywords) ? raw.excludeKeywords.filter(Boolean) : [],
    ocrBlockedKeywords: Array.isArray(raw.ocrBlockedKeywords) ? raw.ocrBlockedKeywords.filter(Boolean) : [],
    ocrTriggerKeywords: Array.isArray(raw.ocrTriggerKeywords) ? raw.ocrTriggerKeywords.filter(Boolean) : [],
    longMessage:
      raw.longMessage && typeof raw.longMessage === "object"
        ? {
            enabled: raw.longMessage.enabled === true,
            threshold: typeof raw.longMessage.threshold === "number" ? raw.longMessage.threshold : undefined,
            appendMessage:
              typeof raw.longMessage.appendMessage === "string" ? raw.longMessage.appendMessage : undefined,
          }
        : undefined,
    replacementsDictionary:
      raw.replacementsDictionary && typeof raw.replacementsDictionary === "object"
        ? raw.replacementsDictionary
        : {},
    showSourceIdentity: raw.showSourceIdentity === true ? true : undefined,
    ignoreSelf: raw.ignoreSelf === true ? true : undefined,
    ignoreBot: raw.ignoreBot === true ? true : undefined,
    ignoreImages: raw.ignoreImages === true ? true : undefined,
    ignoreAudio: raw.ignoreAudio === true ? true : undefined,
    ignoreVideo: raw.ignoreVideo === true ? true : undefined,
    ignoreDocuments: raw.ignoreDocuments === true ? true : undefined,
    ignoreEnglish: raw.ignoreEnglish === true ? true : undefined,
    ignoreEnglishThreshold:
      typeof raw.ignoreEnglishThreshold === "number"
        ? raw.ignoreEnglishThreshold
        : typeof raw.ignoreEnglishThreshold === "string" && raw.ignoreEnglishThreshold.trim() && !isNaN(Number(raw.ignoreEnglishThreshold))
          ? Number(raw.ignoreEnglishThreshold)
          : undefined,
    ignoreChinese: raw.ignoreChinese === true ? true : undefined,
    ignoreChineseThreshold:
      typeof raw.ignoreChineseThreshold === "number"
        ? raw.ignoreChineseThreshold
        : typeof raw.ignoreChineseThreshold === "string" && raw.ignoreChineseThreshold.trim() && !isNaN(Number(raw.ignoreChineseThreshold))
          ? Number(raw.ignoreChineseThreshold)
          : undefined,
    stripEnglish: raw.stripEnglish === true ? true : undefined,
    stripChinese: raw.stripChinese === true ? true : undefined,
    watermark: normalizeWatermarkConfig(raw.watermark),
  };
}

function normalizeRuleConfigs(raw: any): Record<string, RuleLevelConfig> {
  const result: Record<string, RuleLevelConfig> = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [sourceId, config] of Object.entries(raw)) {
    result[sourceId] = normalizeRuleConfig(config);
  }
  return result;
}

function normalizeForwardingTypes(input?: any): ForwardingType[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const filtered = input.filter((value): value is ForwardingType =>
    FORWARDING_TYPES.includes(value as ForwardingType),
  );
  const unique = Array.from(new Set(filtered));
  return unique.length > 0 ? unique : undefined;
}

function parseEnvForwardingTypes(raw?: string): ForwardingType[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parts: string[] = [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        parts = parsed.map((value) => String(value));
      }
    } catch {}
  }
  if (parts.length === 0) {
    parts = trimmed.split(/[,\s]+/);
  }
  const normalized = normalizeForwardingTypes(parts);
  if (!normalized) {
    console.warn(`[Config] ENABLED_FORWARDING_TYPES has no valid values: ${raw}`);
  }
  return normalized;
}

function applyForwardingTypeRestrictions(
  accounts: AccountConfig[],
  allowedTypes?: ForwardingType[],
): AccountConfig[] {
  if (!allowedTypes || allowedTypes.length === 0) return accounts;
  return accounts.map((account) => {
    const current = account.forwardingType || "discord-to-discord";
    if (allowedTypes.includes(current as ForwardingType)) {
      return account;
    }
    return { ...account, forwardingType: allowedTypes[0] };
  });
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
  const feishuRuleConfigs = normalizeRuleConfigs(input?.feishuRuleConfigs);

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

  // 处理 Discord->Discord mappings（保留规则级别配置）
  const mappings: DiscordMappingRule[] = Array.isArray(input?.mappings)
    ? input.mappings.map((m: any) => ({
        id: typeof m.id === "string" ? m.id : randomUUID(),
        sourceChannelId: typeof m.sourceChannelId === "string" ? m.sourceChannelId : "",
        targetWebhookUrl: typeof m.targetWebhookUrl === "string" ? m.targetWebhookUrl : "",
        note: typeof m.note === "string" ? m.note : undefined,
        translateDirection: ["off", "auto", "zh-en", "en-zh"].includes(m.translateDirection) ? m.translateDirection : undefined,
        // RuleLevelConfig 规则级别过滤配置
        allowedUsersIds: Array.isArray(m.allowedUsersIds) ? m.allowedUsersIds : [],
        mutedUsersIds: Array.isArray(m.mutedUsersIds) ? m.mutedUsersIds : [],
        blockedKeywords: Array.isArray(m.blockedKeywords) ? m.blockedKeywords : [],
        excludeKeywords: Array.isArray(m.excludeKeywords) ? m.excludeKeywords : [],
        ocrBlockedKeywords: Array.isArray(m.ocrBlockedKeywords) ? m.ocrBlockedKeywords : [],
        ocrTriggerKeywords: Array.isArray(m.ocrTriggerKeywords) ? m.ocrTriggerKeywords : [],
        longMessage:
          m.longMessage && typeof m.longMessage === "object"
            ? {
                enabled: m.longMessage.enabled === true,
                threshold: typeof m.longMessage.threshold === "number" ? m.longMessage.threshold : undefined,
                appendMessage:
                  typeof m.longMessage.appendMessage === "string" ? m.longMessage.appendMessage : undefined,
              }
            : undefined,
        replacementsDictionary: typeof m.replacementsDictionary === 'object' && m.replacementsDictionary ? m.replacementsDictionary : {},
        // 规则级别忽略配置
        ignoreSelf: m.ignoreSelf === true ? true : undefined,
        ignoreBot: m.ignoreBot === true ? true : undefined,
        ignoreImages: m.ignoreImages === true ? true : undefined,
        ignoreAudio: m.ignoreAudio === true ? true : undefined,
        ignoreVideo: m.ignoreVideo === true ? true : undefined,
        ignoreDocuments: m.ignoreDocuments === true ? true : undefined,
        ignoreEnglish: m.ignoreEnglish === true ? true : undefined,
        ignoreEnglishThreshold:
          typeof m.ignoreEnglishThreshold === "number"
            ? m.ignoreEnglishThreshold
            : typeof m.ignoreEnglishThreshold === "string" && m.ignoreEnglishThreshold.trim() && !isNaN(Number(m.ignoreEnglishThreshold))
              ? Number(m.ignoreEnglishThreshold)
              : undefined,
        ignoreChinese: m.ignoreChinese === true ? true : undefined,
        ignoreChineseThreshold:
          typeof m.ignoreChineseThreshold === "number"
            ? m.ignoreChineseThreshold
            : typeof m.ignoreChineseThreshold === "string" && m.ignoreChineseThreshold.trim() && !isNaN(Number(m.ignoreChineseThreshold))
              ? Number(m.ignoreChineseThreshold)
              : undefined,
        stripEnglish: m.stripEnglish === true ? true : undefined,
        stripChinese: m.stripChinese === true ? true : undefined,
        watermark: normalizeWatermarkConfig(m.watermark),
      }))
    : [];

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
      role: acc.role === "listener" || acc.role === "sender" ? acc.role : undefined,
      sessionType: acc.sessionType === "string" ? "string" : acc.sessionType === "file" ? "file" : undefined,
      loginRequested: acc.loginRequested === true,
      loginNonce: typeof acc.loginNonce === "number" ? acc.loginNonce : undefined,
      loginState: typeof acc.loginState === "string" ? acc.loginState : "idle",
      loginMessage: typeof acc.loginMessage === "string" ? acc.loginMessage : "",
      enabled: acc.enabled !== false
    })) : [],
    mappings: Array.isArray(input.telegramConfig.mappings)
      ? input.telegramConfig.mappings.map((mapping: any) => {
          const rawTarget = typeof mapping.targetChannelId === "string" ? mapping.targetChannelId.trim() : "";
          const targetIsWebhook = /^https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(rawTarget);
          const rawType = typeof mapping.type === "string" ? mapping.type : "";
          let normalizedType: "telegram-to-discord" | "discord-to-telegram" | "telegram-to-telegram" = "telegram-to-discord";
          if (rawType === "discord-to-telegram" || rawType === "telegram-to-discord" || rawType === "telegram-to-telegram") {
            normalizedType = rawType;
          }
          if (targetIsWebhook && normalizedType !== "telegram-to-telegram") {
            normalizedType = "telegram-to-discord";
          }

          return {
            id: typeof mapping.id === "string" ? mapping.id : randomUUID(),
            sourceChannelId: typeof mapping.sourceChannelId === "string" ? mapping.sourceChannelId : "",
            targetChannelId: rawTarget,
            type: normalizedType,
            note: typeof mapping.note === "string" ? mapping.note : undefined,
            translate: mapping.translate === true,
            translateDirection: ["off", "auto", "zh-en", "en-zh"].includes(mapping.translateDirection) ? mapping.translateDirection : "auto",
            senderAccountType: mapping.senderAccountType === "bot" ? "bot" : mapping.senderAccountType === "client" ? "client" : undefined,
            // Telegram特有的超长消息处理（规则级别）
            longMessage: mapping.longMessage && typeof mapping.longMessage === "object" ? {
              enabled: mapping.longMessage.enabled === true,
              threshold: typeof mapping.longMessage.threshold === "number" ? mapping.longMessage.threshold : undefined,
              appendMessage: typeof mapping.longMessage.appendMessage === "string" ? mapping.longMessage.appendMessage : undefined
            } : undefined,
            // RuleLevelConfig 规则级别过滤配置
            allowedUsersIds: Array.isArray(mapping.allowedUsersIds) ? mapping.allowedUsersIds : [],
            mutedUsersIds: Array.isArray(mapping.mutedUsersIds) ? mapping.mutedUsersIds : [],
            blockedKeywords: Array.isArray(mapping.blockedKeywords) ? mapping.blockedKeywords : [],
            excludeKeywords: Array.isArray(mapping.excludeKeywords) ? mapping.excludeKeywords : [],
            ocrBlockedKeywords: Array.isArray(mapping.ocrBlockedKeywords) ? mapping.ocrBlockedKeywords : [],
            ocrTriggerKeywords: Array.isArray(mapping.ocrTriggerKeywords) ? mapping.ocrTriggerKeywords : [],
            replacementsDictionary: typeof mapping.replacementsDictionary === 'object' && mapping.replacementsDictionary ? mapping.replacementsDictionary : {},
            ignoreSelf: mapping.ignoreSelf === true ? true : undefined,
            ignoreBot: mapping.ignoreBot === true ? true : undefined,
            ignoreImages: mapping.ignoreImages === true ? true : undefined,
            ignoreAudio: mapping.ignoreAudio === true ? true : undefined,
            ignoreVideo: mapping.ignoreVideo === true ? true : undefined,
            ignoreDocuments: mapping.ignoreDocuments === true ? true : undefined,
            ignoreEnglish: mapping.ignoreEnglish === true ? true : undefined,
            ignoreEnglishThreshold:
              typeof mapping.ignoreEnglishThreshold === "number"
                ? mapping.ignoreEnglishThreshold
                : typeof mapping.ignoreEnglishThreshold === "string" && mapping.ignoreEnglishThreshold.trim() && !isNaN(Number(mapping.ignoreEnglishThreshold))
                  ? Number(mapping.ignoreEnglishThreshold)
                  : undefined,
            ignoreChinese: mapping.ignoreChinese === true ? true : undefined,
            ignoreChineseThreshold:
              typeof mapping.ignoreChineseThreshold === "number"
                ? mapping.ignoreChineseThreshold
                : typeof mapping.ignoreChineseThreshold === "string" && mapping.ignoreChineseThreshold.trim() && !isNaN(Number(mapping.ignoreChineseThreshold))
                  ? Number(mapping.ignoreChineseThreshold)
                  : undefined,
            stripEnglish: mapping.stripEnglish === true ? true : undefined,
            stripChinese: mapping.stripChinese === true ? true : undefined,
            watermark: normalizeWatermarkConfig(mapping.watermark),
          };
        })
      : [],
    enableTelegramForward: input.telegramConfig.enableTelegramForward === true,
    defaultSenderAccountType:
      input.telegramConfig.defaultSenderAccountType === "bot"
        ? "bot"
        : input.telegramConfig.defaultSenderAccountType === "client"
          ? "client"
          : undefined,
    listenerAccountType:
      input.telegramConfig.listenerAccountType === "bot"
        ? "bot"
        : input.telegramConfig.listenerAccountType === "client"
          ? "client"
          : undefined,
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
    mappings,
    channelFeishuWebhooks,
    feishuRuleConfigs,
    enableFeishuForward: input?.enableFeishuForward === true,
    enableDiscordForward: input?.enableDiscordForward !== false,
    feishuAppId: typeof input?.feishuAppId === "string" && input.feishuAppId.trim() ? input.feishuAppId.trim() : undefined,
    feishuAppSecret: typeof input?.feishuAppSecret === "string" && input.feishuAppSecret.trim() ? input.feishuAppSecret.trim() : undefined,
    channelNotes: input?.channelNotes || {},
    blockedKeywords: Array.isArray(input?.blockedKeywords) ? input.blockedKeywords : [],
    caseInsensitiveKeywords: input?.caseInsensitiveKeywords === false ? false : true,
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
    watermark: normalizeWatermarkConfig(input?.watermark),
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
    ignoreEnglish: input?.ignoreEnglish === true,
    ignoreEnglishThreshold:
      typeof input?.ignoreEnglishThreshold === "number"
        ? input.ignoreEnglishThreshold
        : typeof input?.ignoreEnglishThreshold === "string" && input.ignoreEnglishThreshold.trim() && !isNaN(Number(input.ignoreEnglishThreshold))
          ? Number(input.ignoreEnglishThreshold)
          : undefined,
    ignoreChinese: input?.ignoreChinese === true,
    ignoreChineseThreshold:
      typeof input?.ignoreChineseThreshold === "number"
        ? input.ignoreChineseThreshold
        : typeof input?.ignoreChineseThreshold === "string" && input.ignoreChineseThreshold.trim() && !isNaN(Number(input.ignoreChineseThreshold))
          ? Number(input.ignoreChineseThreshold)
          : undefined,
    stripEnglish: input?.stripEnglish === true,
    stripChinese: input?.stripChinese === true,
    ocrServerUrl: typeof input?.ocrServerUrl === "string" && input.ocrServerUrl.trim() ? input.ocrServerUrl.trim() : "http://localhost:9003",
    ocrBlockedKeywords: Array.isArray(input?.ocrBlockedKeywords) ? input.ocrBlockedKeywords : [],
    ocrTriggerKeywords: Array.isArray(input?.ocrTriggerKeywords) ? input.ocrTriggerKeywords : [],

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
    forwardingType: FORWARDING_TYPES.includes(input?.forwardingType as ForwardingType)
      ? (input.forwardingType as ForwardingType)
      : "discord-to-discord",
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
  const envForwardingTypes = parseEnvForwardingTypes(getEnv().ENABLED_FORWARDING_TYPES);
  const effectiveForwardingTypes = envForwardingTypes;
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
      enabledForwardingTypes: envForwardingTypes,
    };

    // 如果版本有更新，保存配置
    if (version !== CONFIG_VERSION) {
      await saveMultiConfig(config);
      console.log(`Migrated config from version ${version} to ${CONFIG_VERSION}`);
    }

    const restrictedAccounts = applyForwardingTypeRestrictions(migratedAccounts, effectiveForwardingTypes);
    return {
      ...config,
      accounts: restrictedAccounts,
      enabledForwardingTypes: envForwardingTypes,
    };
  }
  const legacyConfig = migrateLegacyToMulti(raw);
  const legacyRestrictedAccounts = applyForwardingTypeRestrictions(
    legacyConfig.accounts,
    effectiveForwardingTypes,
  );
  return {
    ...legacyConfig,
    accounts: legacyRestrictedAccounts,
    enabledForwardingTypes: envForwardingTypes,
  };
}

export async function saveMultiConfig(config: MultiConfig) {
  const { enabledForwardingTypes: _ignored, ...payload } = config;
  const content = JSON.stringify(payload, null, 2) + "\n";
  const tmpPath = path.join(path.dirname(CONFIG_PATH), `config.json.tmp-${randomUUID()}`);
  await writeFile(tmpPath, content);
  await rename(tmpPath, CONFIG_PATH);
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
      caseInsensitiveKeywords: true,
      excludeKeywords: [],
      ocrBlockedKeywords: [],
      ocrTriggerKeywords: [],
      showSourceIdentity: false,
      publicBaseUrl: undefined,
      replacementsDictionary: {},
      watermark: undefined,
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
      ignoreEnglish: false,
      ignoreEnglishThreshold: 100,
      ignoreChinese: false,
      ignoreChineseThreshold: 100,
      stripEnglish: false,
      stripChinese: false,
      feishuStyle: "style1",
      channelTranslate: {},
      channelTranslateDirection: {},
    };
  }
  return {
    channelWebhooks: account.channelWebhooks,
    channelFeishuWebhooks: account.channelFeishuWebhooks,
    mappings: account.mappings,
    feishuRuleConfigs: account.feishuRuleConfigs,
    enableFeishuForward: account.enableFeishuForward,
    enableDiscordForward: account.enableDiscordForward,
    feishuAppId: account.feishuAppId,
    feishuAppSecret: account.feishuAppSecret,
    channelNotes: account.channelNotes,
    blockedKeywords: account.blockedKeywords,
    caseInsensitiveKeywords: account.caseInsensitiveKeywords,
    excludeKeywords: account.excludeKeywords,
    showSourceIdentity: account.showSourceIdentity,
    publicBaseUrl: account.publicBaseUrl,
    showDate: account.showDate,
    showChat: account.showChat,
    stackMessages: account.stackMessages,
    showMessageDeletions: account.showMessageDeletions,
    showMessageUpdates: account.showMessageUpdates,
    replacementsDictionary: account.replacementsDictionary,
    watermark: account.watermark,
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
    ignoreEnglish: account.ignoreEnglish,
    ignoreEnglishThreshold: account.ignoreEnglishThreshold,
    ignoreChinese: account.ignoreChinese,
    ignoreChineseThreshold: account.ignoreChineseThreshold,
    stripEnglish: account.stripEnglish,
    stripChinese: account.stripChinese,
    ocrServerUrl: account.ocrServerUrl,
    ocrBlockedKeywords: account.ocrBlockedKeywords,
    ocrTriggerKeywords: account.ocrTriggerKeywords,
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
