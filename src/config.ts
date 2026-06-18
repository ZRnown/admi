import { copyFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import path from "node:path";
import { randomUUID } from "crypto";
import { getEnv } from "./env";
import { resolveProjectPath } from "./paths";
import { clearDiscordLibraryReferences } from "./discordLibraryCleanup";
import { normalizeDiscordMappingRule, normalizeTelegramMapping } from "./mappingNormalization";

export type ChannelId = number | string;
export type ChatId = ChannelId;

const CONFIG_PATH = resolveConfigPath();
const CONFIG_BACKUP_LIMIT = 100;

export function getConfigPath(): string {
  return CONFIG_PATH;
}

const FORWARDING_TYPES = [
  "discord-to-discord",
  "discord-to-telegram",
  "discord-to-mobile-client",
  "telegram-to-discord",
  "telegram-to-telegram",
  "telegram-to-mobile-client",
  "telegram-to-dingtalk",
  "discord-to-feishu",
  "discord-to-dingtalk",
  "discord-to-safew",
  "x-to-discord",
  "truthsocial-to-discord",
] as const;

type ForwardingType = (typeof FORWARDING_TYPES)[number];
const MOBILE_CLIENT_FORWARDING_TYPES: ForwardingType[] = [
  "discord-to-mobile-client",
  "telegram-to-mobile-client",
];
const DEFAULT_ENABLED_FORWARDING_TYPES: ForwardingType[] = ["discord-to-dingtalk"];

function resolveConfigPath(): string {
  if (process.env.CONFIG_PATH) {
    return process.env.CONFIG_PATH;
  }
  return resolveProjectPath("config.json");
}

// Telegram相关类型定义
export interface TelegramAccountConfig {
  id: string;
  name: string;
  remark?: string;
  type: 'client' | 'bot';  // client = 用户客户端, bot = 机器人
  token: string;           // Bot Token 或 API Hash (client)
  sessionPath?: string;    // Session文件路径 (仅client)
  sessionString?: string;  // Session字符串 (仅client, 加密存储)
  apiId?: number;          // API ID (仅client)
  apiHash?: string;        // API Hash (仅client)
  phoneNumber?: string;
  twoFactorPassword?: string;
  proxyUrl?: string;
  role?: "listener" | "sender";
  sessionType?: "file" | "string";
  loginRequested?: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  enabled?: boolean;
  syncedUser?: Record<string, any>;
  lastSyncTime?: string;
  dialogsCount?: number;
}

export interface DiscordAccountLibrary {
  id: string;
  name: string;
  remark?: string;
  type: "bot" | "selfbot";
  token?: string;
  email?: string;
  password?: string;
  totpSecret?: string;
  proxyUrl?: string;
  loginEnabled?: boolean;
  syncedUser?: Record<string, any>;
  lastSyncTime?: string;
  guildsCount?: number;
  channelsCount?: number;
}

export interface XAccountLibrary {
  id: string;
  name: string;
  remark?: string;
  apiKey?: string;
  apiBaseUrl?: string;
}

export interface TruthSocialAccountLibrary {
  id: string;
  name: string;
  remark?: string;
  username?: string;
  password?: string;
}

export interface TelegramMapping extends RuleLevelConfig {
  id: string;
  sourceChannelId: string;     // 源频道ID
  sourceGuildId?: string;      // Discord来源服务器ID（用于discord-to-telegram）
  sourceGuildName?: string;
  sourceChannelName?: string;
  mobileClientCategoryName?: string;
  mobileClientChannelName?: string;
  mobileClientChannelAvatarUrl?: string;
  sourceThreadId?: string;
  targetChannelId: string;     // 目标频道ID
  type: 'telegram-to-discord' | 'discord-to-telegram' | 'telegram-to-telegram' | 'telegram-to-mobile-client' | 'telegram-to-dingtalk';
  inputMode?: "manual" | "select";
  note?: string;
  translate?: boolean;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
  senderAccountType?: 'bot' | 'client';
  discordSenderType?: "account" | "webhook";
  discordSenderAccountId?: string;
  dingtalkSecret?: string;
  targetGuildId?: string;
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
  phoneNumber?: string;
  twoFactorPassword?: string;
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
  sourceGuildId?: string;
  sourceGuildName?: string;
  sourceChannelName?: string;
  mobileClientCategoryName?: string;
  mobileClientChannelName?: string;
  mobileClientChannelAvatarUrl?: string;
  sourceThreadId?: string;
  targetChannelId: string;
  type: 'telegram-to-discord' | 'discord-to-telegram' | 'telegram-to-telegram' | 'telegram-to-mobile-client' | 'telegram-to-dingtalk';
  inputMode?: "manual" | "select";
  note?: string;
  translate?: boolean;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
  senderAccountType?: 'bot' | 'client';
  discordSenderType?: "account" | "webhook";
  discordSenderAccountId?: string;
  dingtalkSecret?: string;
  targetGuildId?: string;
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

export type WatermarkPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center" | "top" | "bottom";

export interface WatermarkConfig {
  enabled?: boolean;
  mode?: "text" | "image";
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

export type WatermarkList = WatermarkConfig[];

export type WatermarkRemovalMode = "ocr" | "always";
export type WatermarkRemovalProvider = "wavespeed" | "iopaint";
export type IOPaintModel = "lama" | "migan" | "mat";
export type IOPaintStrategy = "crop" | "resize" | "original";
export type IOPaintMaskMode = "protect-text" | "box";

export interface WatermarkRemovalManualRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

export interface WatermarkRemovalConfig {
  enabled?: boolean;
  mode?: WatermarkRemovalMode;
  provider?: WatermarkRemovalProvider;
  apiKey?: string;
  triggerKeywords?: string[];
  iopaintModel?: IOPaintModel;
  iopaintStrategy?: IOPaintStrategy;
  iopaintMaskMode?: IOPaintMaskMode;
  iopaintMaskPadding?: number;
  manualRegions?: WatermarkRemovalManualRegion[];
}

export type ScheduledMediaType = "image" | "video";
export type ScheduledMediaSource = "local" | "url";

export interface ScheduledContentItem {
  id: string;
  name?: string;
  text?: string;
  mediaType?: ScheduledMediaType;
  mediaSource?: ScheduledMediaSource;
  mediaValue?: string;
  enabled?: boolean;
}

export interface ScheduledBroadcastConfig {
  enabled?: boolean;
  intervalMinutes?: number;
  contentIds?: string[];
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
  // 只转发机器人/系统 Webhook 消息（规则级别）
  onlyBot?: boolean;
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
  watermarkSecondary?: WatermarkConfig;
  watermarks?: WatermarkList;
  watermarkRemoval?: WatermarkRemovalConfig;
  scheduledBroadcast?: ScheduledBroadcastConfig;
  standbyMode?: {
    enabled: boolean;
    mainChannelId: string;
    cooldownSeconds: number;
    mainGuildId?: string;
    mainGuildName?: string;
  };
  // 规则输入模式（用于来源频道选择方式）
  inputMode?: "manual" | "select";
  targetWebhookName?: string;
  targetWebhookAvatarUrl?: string;
}

// Discord→Discord 规则映射（支持规则级别的完整配置）
export interface DiscordMappingRule extends RuleLevelConfig {
  id: string;
  sourceChannelId: string;
  sourceGuildId?: string;
  sourceGuildName?: string;
  sourceChannelName?: string;
  targetWebhookUrl: string;
  targetChannelId?: string;
  targetGuildId?: string;
  discordSenderType?: "account" | "webhook";
  discordSenderAccountId?: string;
  dingtalkSecret?: string;
  inputMode?: "manual" | "select";
  note?: string;
  translateDirection?: 'off' | 'auto' | 'zh-en' | 'en-zh';
}

export interface XForwardingRule extends RuleLevelConfig {
  id: string;
  sourceUserName?: string;
  sourceUserId?: string;
  targetWebhookUrl: string;
  note?: string;
  includeReplies?: boolean;
  includeRetweets?: boolean;
  pollIntervalSeconds?: number;
}

export type XStreamMode = "poll" | "websocket";
export type XSourceProvider = "twitterapi" | "twscrape";

export interface XSourceConfig {
  apiKey?: string;
  apiBaseUrl?: string;
  sourceProvider?: XSourceProvider;
  twscrapeDbPath?: string;
  mode?: XStreamMode;
  pollIntervalSeconds?: number;
  mappings?: XForwardingRule[];
}

export interface TruthSocialForwardingRule extends RuleLevelConfig {
  id: string;
  sourceHandle: string;
  targetWebhookUrl: string;
  note?: string;
  pollIntervalSeconds?: number;
}

export interface TruthSocialConfig {
  username?: string;
  password?: string;
  pollIntervalSeconds?: number;
  mappings?: TruthSocialForwardingRule[];
}

export type FeishuTargetMode = "webhook" | "thread";

export interface FeishuTargetConfig {
  mode: FeishuTargetMode;
  webhookUrl?: string;
  threadId?: string;
}

export type FeishuTargetMap = Record<string, FeishuTargetConfig | string>;

export interface FeishuMappingRule extends RuleLevelConfig {
  id: string;
  sourceChannelId: string;
  sourceGuildId?: string;
  sourceGuildName?: string;
  sourceChannelName?: string;
  target: FeishuTargetConfig;
  note?: string;
  inputMode?: "select" | "manual";
}

export interface SafewBotAccountConfig {
  id: string;
  name: string;
  botToken: string;
  loginState?: string;
  loginMessage?: string;
  groups?: Array<{ id: string; title: string; type?: string }>;
}

export interface MobileClientTargetConfig {
  enabled?: boolean;
  endpoint?: string;
  adminToken?: string;
  guildId?: string;
  guildName?: string;
}

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
  safewBotToken?: string;
  safewAccounts?: SafewBotAccountConfig[];
  // 每个频道的备注，仅用于管理界面展示
  channelNotes?: Record<string, string>;
  mutedGuildsIds?: ChannelId[];
  allowedGuildsIds?: ChannelId[];
  mutedChannelsIds?: ChannelId[];
  allowedChannelsIds?: ChannelId[];
  allowedUsersIds?: ChannelId[];
  mutedUsersIds?: ChannelId[];
  allowedRoleIds?: ChannelId[];
  mutedRoleIds?: ChannelId[];
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
  watermarkSecondary?: WatermarkConfig;
  watermarks?: WatermarkList;
  watermarkEnabled?: boolean;
  watermarkRemoval?: WatermarkRemovalConfig;
  scheduledContents?: ScheduledContentItem[];
  scheduledBroadcast?: ScheduledBroadcastConfig;
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
  translationBaseUrl?: string;
  translationModel?: string;
  translationPrompt?: string;
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
  onlyBot?: boolean;
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
  // 连续重复消息去重（上一条与当前相同则跳过）
  dedupeSequentialMessages?: boolean;
  // Discord -> Discord 转发样式：style1 = 当前内嵌样式；style2 = 纯文本样式（带时间等）；style3 = 纯文本样式（隐藏回复对象）
  feishuStyle?: "style1" | "style2" | "style3";
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
  // 手机客户端目标配置
  mobileClientTarget?: MobileClientTargetConfig;
  // Discord→Discord 规则列表（带规则级别用户过滤）
  mappings?: DiscordMappingRule[];
  // 飞书规则级别过滤配置
  feishuRuleConfigs?: Record<string, RuleLevelConfig>;
  // 飞书规则列表。新版使用独立规则 ID，支持同一个源频道转发到多个飞书目标。
  feishuMappings?: FeishuMappingRule[];
  // Discord 登录配置（兼容旧字段）
  discordLogin?: {
    email?: string;
    password?: string;
    totpSecret?: string;
  };
  // X/Twitter 转发配置
  xConfig?: XSourceConfig;
  // TruthSocial 转发配置
  truthSocialConfig?: TruthSocialConfig;
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
  feishuMappings?: FeishuMappingRule[];
  feishuSourceGuildMap?: Record<string, string>;
  feishuSourceChannelNameMap?: Record<string, string>;
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
  // 全局账号库选择
  discordAccountId?: string;
  telegramListenerAccountId?: string;
  telegramSenderAccountId?: string;
  xAccountId?: string;
  truthSocialAccountId?: string;
  // 新增：统一的监听/发送账号选择
  listenerAccountId?: string;  // 监听账号ID（从账号库选择）
  senderAccountId?: string;    // 发送账号ID（从账号库选择，或为空表示使用webhook）
  senderType?: "account" | "webhook";  // 发送方式
  // OCR配置
  enableOCR?: boolean;
  ocrServerUrl?: string;
  ocrBlockedKeywords?: string[];
  ocrTriggerKeywords?: string[];
  watermark?: WatermarkConfig;
  watermarkSecondary?: WatermarkConfig;
  watermarks?: WatermarkList;
  watermarkEnabled?: boolean;
  watermarkRemoval?: WatermarkRemovalConfig;
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
  mobileClientTarget?: MobileClientTargetConfig;
}

export interface MultiConfig {
  accounts: AccountConfig[];
  activeId?: string;
  // 管理面板登录用户名/密码（可选）
  loginUser?: string;
  loginPassword?: string;
  telegramAvatarBaseUrl?: string;
  // 全局账号库
  discordAccounts?: DiscordAccountLibrary[];
  telegramAccounts?: TelegramAccountConfig[];
  xAccounts?: XAccountLibrary[];
  truthSocialAccounts?: TruthSocialAccountLibrary[];
  // 配置版本，用于迁移
  version?: string;
  // 启用的转发类型（如果不设置，默认全部启用）
  enabledForwardingTypes?: ForwardingType[];
  mobileClientTarget?: MobileClientTargetConfig;
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
    allowedRoleIds: [],
    mutedRoleIds: [],
    channelConfigs: {},
    enableTranslation: false,
    deepseekApiKey: undefined,
    translationProvider: "deepseek",
    translationApiKey: undefined,
    translationSecret: undefined,
    translationBaseUrl: undefined,
    translationModel: undefined,
    translationPrompt: undefined,
    enableFeishuForward: false,
    channelFeishuWebhooks: {},
    feishuAppId: undefined,
    feishuAppSecret: undefined,
    safewBotToken: undefined,
    safewAccounts: [],
    ocrServerUrl: "http://localhost:9003",
    ocrBlockedKeywords: [],
    ocrTriggerKeywords: [],
    watermarkRemoval: {
      enabled: false,
      mode: "ocr",
      provider: "iopaint",
      apiKey: undefined,
      triggerKeywords: [],
      iopaintModel: "lama",
      iopaintStrategy: "crop",
      iopaintMaskMode: "protect-text",
    },
    discordLogin: undefined,
    botRelays: [],
    channelRelayMap: {},
    feishuStyle: "style1",
    channelTranslate: {},
    channelTranslateDirection: {},
    watermarkEnabled: true,
    dedupeSequentialMessages: false,
    xConfig: undefined,
    truthSocialConfig: undefined,
    scheduledContents: [],
    scheduledBroadcast: { enabled: false, intervalMinutes: 60, contentIds: [] },
  };
}

// 当前配置版本
export const CONFIG_VERSION = "1.2.0"; // 添加全局账号库支持

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
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      return {};
    }
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
    return { mode: "thread", threadId };
  }
  const webhookUrl = typeof raw.webhookUrl === "string" ? raw.webhookUrl.trim() : "";
  return { mode: "webhook", webhookUrl };
}

function normalizeFeishuMappingRule(raw: any): FeishuMappingRule | null {
  if (!raw || typeof raw !== "object") return null;
  const target = normalizeFeishuTarget(raw.target || raw);
  if (!target) return null;
  const sourceChannelId = typeof raw.sourceChannelId === "string" ? raw.sourceChannelId.trim() : "";
  if (!sourceChannelId) return null;
  const ruleConfig = normalizeRuleConfig(raw);
  return {
    ...ruleConfig,
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID(),
    sourceChannelId,
    sourceGuildId: typeof raw.sourceGuildId === "string" && raw.sourceGuildId.trim() ? raw.sourceGuildId.trim() : undefined,
    sourceGuildName: typeof raw.sourceGuildName === "string" && raw.sourceGuildName.trim() ? raw.sourceGuildName.trim() : undefined,
    sourceChannelName:
      typeof raw.sourceChannelName === "string" && raw.sourceChannelName.trim() ? raw.sourceChannelName.trim() : undefined,
    target,
    note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined,
    inputMode: raw.inputMode === "manual" ? "manual" : raw.inputMode === "select" ? "select" : ruleConfig.inputMode,
  };
}

function normalizeFeishuMappings(input: any): FeishuMappingRule[] {
  if (Array.isArray(input?.feishuMappings)) {
    return input.feishuMappings
      .map((item: any) => normalizeFeishuMappingRule(item))
      .filter((item: FeishuMappingRule | null): item is FeishuMappingRule => Boolean(item));
  }

  const hooks = input?.channelFeishuWebhooks && typeof input.channelFeishuWebhooks === "object" ? input.channelFeishuWebhooks : {};
  const notes = input?.channelNotes && typeof input.channelNotes === "object" ? input.channelNotes : {};
  const guildMap = input?.feishuSourceGuildMap && typeof input.feishuSourceGuildMap === "object" ? input.feishuSourceGuildMap : {};
  const guildNameMap =
    input?.feishuSourceGuildNameMap && typeof input.feishuSourceGuildNameMap === "object" ? input.feishuSourceGuildNameMap : {};
  const channelNameMap =
    input?.feishuSourceChannelNameMap && typeof input.feishuSourceChannelNameMap === "object"
      ? input.feishuSourceChannelNameMap
      : {};
  const ruleConfigs = normalizeRuleConfigs(input?.feishuRuleConfigs);
  const result: FeishuMappingRule[] = [];
  for (const [sourceChannelId, rawTarget] of Object.entries(hooks)) {
    const source = String(sourceChannelId || "").trim();
    const target = normalizeFeishuTarget(rawTarget);
    if (!source || !target) continue;
    const ruleConfig = ruleConfigs[source] || {};
    result.push({
      ...ruleConfig,
      id: `legacy-feishu-${source}`,
      sourceChannelId: source,
      sourceGuildId: typeof guildMap[source] === "string" && guildMap[source].trim() ? guildMap[source].trim() : undefined,
      sourceGuildName:
        typeof guildNameMap[source] === "string" && guildNameMap[source].trim() ? guildNameMap[source].trim() : undefined,
      sourceChannelName:
        typeof channelNameMap[source] === "string" && channelNameMap[source].trim() ? channelNameMap[source].trim() : undefined,
      target,
      note: typeof notes[source] === "string" && notes[source].trim() ? notes[source].trim() : undefined,
      inputMode: ruleConfig.inputMode === "manual" ? "manual" : ruleConfig.inputMode === "select" ? "select" : undefined,
    });
  }
  return result;
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
    const allowed: WatermarkPosition[] = ["top-left", "top-right", "bottom-left", "bottom-right", "center", "top", "bottom"];
    return allowed.includes(value as WatermarkPosition) ? (value as WatermarkPosition) : undefined;
  };
  const normalizeMode = (value: any): "text" | "image" | undefined => {
    if (value === "text" || value === "image") return value;
    if (value === "both") {
      return normalizeText(raw.imageUrl) ? "image" : "text";
    }
    return undefined;
  };
  const normalizePattern = (value: any): "single" | "tile" | undefined => {
    if (value === "single" || value === "tile") return value;
    return undefined;
  };

  const normalizedText = normalizeText(raw.text);
  const normalizedImageUrl = normalizeText(raw.imageUrl);
  const normalizedMode = normalizeMode(raw.mode) ?? (normalizedImageUrl ? "image" : normalizedText ? "text" : undefined);
  const hasContent = Boolean(normalizedText || normalizedImageUrl);
  const enabled =
    raw.enabled === true ? true : raw.enabled === false ? false : hasContent;

  return {
    enabled,
    mode: normalizedMode,
    pattern: normalizePattern(raw.pattern),
    tileGap: normalizeNumber(raw.tileGap),
    text: normalizedText,
    textSize: normalizeNumber(raw.textSize),
    textColor: normalizeText(raw.textColor),
    textOpacity: normalizeNumber(raw.textOpacity),
    textAngle: normalizeNumber(raw.textAngle),
    fontFamily: normalizeText(raw.fontFamily),
    fontPath: normalizeText(raw.fontPath),
    imageUrl: normalizedImageUrl,
    imageOpacity: normalizeNumber(raw.imageOpacity),
    imageScale: normalizeNumber(raw.imageScale),
    position: normalizePosition(raw.position),
    margin: normalizeNumber(raw.margin),
  };
}

function normalizeWatermarkList(raw: any): WatermarkList | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .map((item) => normalizeWatermarkConfig(item))
    .filter((item): item is WatermarkConfig => !!item);
  return list.length > 0 ? list : [];
}

function mergeLegacyWatermarks(
  list: WatermarkList | undefined,
  primary?: WatermarkConfig,
  secondary?: WatermarkConfig,
): WatermarkList | undefined {
  if (list !== undefined) return list;
  const legacy = [primary, secondary].filter((item): item is WatermarkConfig => !!item);
  return legacy.length > 0 ? legacy : undefined;
}

function normalizeWatermarkRemovalConfig(raw: any): WatermarkRemovalConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined;
  const mode: WatermarkRemovalMode = raw.mode === "ocr" ? "ocr" : "always";
  const provider: WatermarkRemovalProvider = raw.provider === "iopaint" ? "iopaint" : apiKey ? "wavespeed" : "iopaint";
  const triggerKeywords = Array.isArray(raw.triggerKeywords)
    ? raw.triggerKeywords.map((item: any) => String(item || "").trim()).filter(Boolean)
    : undefined;
  const iopaintModel: IOPaintModel = raw.iopaintModel === "migan" || raw.iopaintModel === "mat" ? raw.iopaintModel : "lama";
  const iopaintStrategy: IOPaintStrategy =
    raw.iopaintStrategy === "resize" || raw.iopaintStrategy === "original" ? raw.iopaintStrategy : "crop";
  const iopaintMaskMode: IOPaintMaskMode = raw.iopaintMaskMode === "box" ? "box" : "protect-text";
  const parsedMaskPadding = Number(raw.iopaintMaskPadding);
  const iopaintMaskPadding = Number.isFinite(parsedMaskPadding) && parsedMaskPadding >= 0
    ? Math.floor(parsedMaskPadding)
    : undefined;
  const manualRegions = Array.isArray(raw.manualRegions)
    ? raw.manualRegions
        .map((item: any) => {
          if (!item || typeof item !== "object") return undefined;
          const x = Number(item.x);
          const y = Number(item.y);
          const width = Number(item.width);
          const height = Number(item.height);
          if (![x, y, width, height].every(Number.isFinite)) return undefined;
          const clampedX = Math.max(0, Math.min(1, x));
          const clampedY = Math.max(0, Math.min(1, y));
          const clampedWidth = Math.max(0, Math.min(1 - clampedX, width));
          const clampedHeight = Math.max(0, Math.min(1 - clampedY, height));
          if (clampedWidth <= 0 || clampedHeight <= 0) return undefined;
          const label = typeof item.label === "string" && item.label.trim() ? item.label.trim() : undefined;
          return { x: clampedX, y: clampedY, width: clampedWidth, height: clampedHeight, label };
        })
        .filter((item: any): item is WatermarkRemovalManualRegion => Boolean(item))
    : undefined;
  const enabled = raw.enabled === true ? true : raw.enabled === false ? false : Boolean(apiKey || provider === "iopaint");
  if (
    !enabled &&
    !apiKey &&
    raw.mode === undefined &&
    raw.provider === undefined &&
    triggerKeywords === undefined &&
    raw.iopaintModel === undefined &&
    raw.iopaintStrategy === undefined &&
    raw.iopaintMaskMode === undefined &&
    raw.iopaintMaskPadding === undefined &&
    raw.manualRegions === undefined
  ) {
    return undefined;
  }
  return {
    enabled,
    mode,
    provider,
    apiKey,
    triggerKeywords,
    iopaintModel: provider === "iopaint" ? iopaintModel : undefined,
    iopaintStrategy: provider === "iopaint" ? iopaintStrategy : undefined,
    iopaintMaskMode: provider === "iopaint" ? iopaintMaskMode : undefined,
    iopaintMaskPadding: provider === "iopaint" ? iopaintMaskPadding : undefined,
    manualRegions: provider === "iopaint" && manualRegions && manualRegions.length > 0 ? manualRegions : undefined,
  };
}

function normalizeScheduledContentItem(raw: any): ScheduledContentItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const id =
    typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : randomUUID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  const text = typeof raw.text === "string" ? raw.text : undefined;
  const mediaType: ScheduledMediaType | undefined =
    raw.mediaType === "image" || raw.mediaType === "video" ? raw.mediaType : undefined;
  const mediaSource: ScheduledMediaSource | undefined =
    raw.mediaSource === "local" || raw.mediaSource === "url" ? raw.mediaSource : undefined;
  const mediaValue =
    typeof raw.mediaValue === "string" && raw.mediaValue.trim() ? raw.mediaValue.trim() : undefined;
  const enabled = raw.enabled === true ? true : raw.enabled === false ? false : undefined;
  return {
    id,
    name,
    text,
    mediaType,
    mediaSource,
    mediaValue,
    enabled,
  };
}

function normalizeScheduledContentList(raw: any): ScheduledContentItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .map((item) => normalizeScheduledContentItem(item))
    .filter((item): item is ScheduledContentItem => !!item);
  return list.length > 0 ? list : [];
}

function normalizeScheduledBroadcastConfig(raw: any): ScheduledBroadcastConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const normalizeNumber = (value: any): number | undefined => {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() && !isNaN(Number(value))) {
      return Number(value);
    }
    return undefined;
  };
  const intervalMinutes = normalizeNumber(raw.intervalMinutes);
  const contentIds = Array.isArray(raw.contentIds) ? raw.contentIds.map(String).filter(Boolean) : undefined;
  const hasContent = (contentIds?.length || 0) > 0;
  const enabled =
    raw.enabled === true ? true : raw.enabled === false ? false : hasContent && !!intervalMinutes;
  return {
    enabled,
    intervalMinutes,
    contentIds,
  };
}

function normalizeMobileClientTargetConfig(raw: any): MobileClientTargetConfig | undefined {
  const source = raw && typeof raw === "object" ? raw : {};
  const endpoint =
    typeof source.endpoint === "string" && source.endpoint.trim()
      ? source.endpoint.trim().replace(/\/+$/, "")
      : process.env.MOBILE_CLIENT_SYNC_ENDPOINT || "http://192.210.141.219:8765";
  const adminToken =
    typeof source.adminToken === "string" && source.adminToken.trim()
      ? source.adminToken.trim()
      : process.env.MOBILE_CLIENT_SYNC_ADMIN_TOKEN || "jujing-admin-2026";
  const guildId =
    typeof source.guildId === "string" && source.guildId.trim()
      ? source.guildId.trim()
      : "mobile-client";
  const guildName =
    typeof source.guildName === "string" && source.guildName.trim()
      ? source.guildName.trim()
      : "手机客户端";
  const enabled = source.enabled === true;
  if (!enabled && !raw) return undefined;
  return { enabled, endpoint, adminToken, guildId, guildName };
}

function normalizeStandbyMode(raw: any): RuleLevelConfig["standbyMode"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const mainChannelId = typeof raw.mainChannelId === "string" ? raw.mainChannelId.trim() : "";
  const mainGuildId = typeof raw.mainGuildId === "string" ? raw.mainGuildId.trim() : "";
  const mainGuildName = typeof raw.mainGuildName === "string" ? raw.mainGuildName.trim() : "";
  const cooldownSeconds =
    typeof raw.cooldownSeconds === "number"
      ? raw.cooldownSeconds
      : typeof raw.cooldownSeconds === "string" && raw.cooldownSeconds.trim() && !isNaN(Number(raw.cooldownSeconds))
        ? Number(raw.cooldownSeconds)
        : 60;
  const enabled = raw.enabled === true;
  if (!enabled && !mainChannelId) return undefined;
  const result: RuleLevelConfig["standbyMode"] = {
    enabled,
    mainChannelId,
    cooldownSeconds: Number.isFinite(cooldownSeconds) ? cooldownSeconds : 60,
  };
  if (mainGuildId) result.mainGuildId = mainGuildId;
  if (mainGuildName) result.mainGuildName = mainGuildName;
  return result;
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
      watermarkSecondary: undefined,
      watermarks: undefined,
      watermarkRemoval: undefined,
      scheduledBroadcast: undefined,
      standbyMode: undefined,
      inputMode: undefined,
    };
  }
  const watermark = normalizeWatermarkConfig(raw.watermark);
  const watermarkSecondary = normalizeWatermarkConfig(raw.watermarkSecondary);
  const watermarks = mergeLegacyWatermarks(normalizeWatermarkList(raw.watermarks), watermark, watermarkSecondary);
  const watermarkRemoval = normalizeWatermarkRemovalConfig(raw.watermarkRemoval);
  const scheduledBroadcast = normalizeScheduledBroadcastConfig(raw.scheduledBroadcast);
  const standbyMode = normalizeStandbyMode(raw.standbyMode);
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
    onlyBot: raw.onlyBot === true ? true : undefined,
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
    watermark,
    watermarkSecondary,
    watermarks,
    watermarkRemoval,
    scheduledBroadcast,
    standbyMode,
    inputMode:
      raw.inputMode === "manual" ? "manual" : raw.inputMode === "select" ? "select" : undefined,
  };
}

const TELEGRAM_PLACEHOLDER_NAMES = new Set([
  "Telegram Account",
  "Telegram账号",
  "Telegram 账号",
  "Telegram 发送账号",
  "Telegram 监听账号",
]);

function isTelegramPlaceholderName(rawName: unknown): boolean {
  if (typeof rawName !== "string") return false;
  const trimmed = rawName.trim();
  if (!trimmed) return false;
  return TELEGRAM_PLACEHOLDER_NAMES.has(trimmed);
}

function sanitizeTelegramAccountName(rawName: unknown): string {
  if (typeof rawName !== "string") return "";
  const trimmed = rawName.trim();
  if (!trimmed) return "";
  if (isTelegramPlaceholderName(trimmed)) return "";
  return trimmed;
}

function hasTelegramCredentials(acc: any): boolean {
  if (!acc || typeof acc !== "object") return false;
  const token = typeof acc.token === "string" ? acc.token.trim() : "";
  const apiHash = typeof acc.apiHash === "string" ? acc.apiHash.trim() : "";
  const apiId =
    typeof acc.apiId === "number"
      ? Number.isFinite(acc.apiId)
      : typeof acc.apiId === "string"
        ? acc.apiId.trim().length > 0
        : false;
  const sessionPath = typeof acc.sessionPath === "string" ? acc.sessionPath.trim() : "";
  const sessionString = typeof acc.sessionString === "string" ? acc.sessionString.trim() : "";
  const phone = typeof acc.phoneNumber === "string" ? acc.phoneNumber.trim() : "";
  return Boolean(token || apiHash || apiId || sessionPath || sessionString || phone);
}

function isTelegramAutoPlaceholderAccount(acc: any): boolean {
  if (!acc || typeof acc !== "object") return false;
  if (hasTelegramCredentials(acc)) return false;
  const name = typeof acc.name === "string" ? acc.name.trim() : "";
  const id = typeof acc.id === "string" ? acc.id : "";
  const role = acc.role;
  const idLooksAuto = /_tg_(listener|sender)_/i.test(id);
  const roleLooksAuto = role === "listener" || role === "sender";
  const nameLooksAuto = isTelegramPlaceholderName(name);
  return idLooksAuto || roleLooksAuto || nameLooksAuto;
}

function normalizeTelegramAccountList(raw: any): TelegramAccountConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((acc: any): TelegramAccountConfig => {
      const normalizedType: "bot" | "client" = acc?.type === "bot" ? "bot" : "client";
      return {
        id: typeof acc.id === "string" ? acc.id : randomUUID(),
        name: sanitizeTelegramAccountName(acc.name),
        remark: typeof acc.remark === "string" && acc.remark.trim() ? acc.remark.trim() : undefined,
        type: normalizedType,
        token: typeof acc.token === "string" ? acc.token : "",
        sessionPath: typeof acc.sessionPath === "string" ? acc.sessionPath : undefined,
        sessionString: typeof acc.sessionString === "string" ? acc.sessionString : undefined,
        apiId: typeof acc.apiId === "number" ? acc.apiId : undefined,
        apiHash: typeof acc.apiHash === "string" ? acc.apiHash : undefined,
        phoneNumber: typeof acc.phoneNumber === "string" ? acc.phoneNumber : undefined,
        twoFactorPassword: typeof acc.twoFactorPassword === "string" ? acc.twoFactorPassword : undefined,
        role: acc.role === "listener" || acc.role === "sender" ? acc.role : undefined,
        sessionType: acc.sessionType === "string" ? "string" : acc.sessionType === "file" ? "file" : undefined,
        loginRequested: acc.loginRequested === true,
        loginNonce: typeof acc.loginNonce === "number" ? acc.loginNonce : undefined,
        loginState: typeof acc.loginState === "string" ? acc.loginState : "idle",
        loginMessage: typeof acc.loginMessage === "string" ? acc.loginMessage : "",
        enabled: acc.enabled !== false,
        syncedUser: acc.syncedUser && typeof acc.syncedUser === "object" ? acc.syncedUser : undefined,
        lastSyncTime: typeof acc.lastSyncTime === "string" ? acc.lastSyncTime : undefined,
        dialogsCount: typeof acc.dialogsCount === "number" ? acc.dialogsCount : undefined,
      };
    })
    .filter((acc) => !isTelegramAutoPlaceholderAccount(acc));
}

function hasLegacyTelegramBotConfig(account: AccountConfig): boolean {
  return typeof account.telegramBotToken === "string" && account.telegramBotToken.trim().length > 0;
}

function hasLegacyTelegramClientConfig(account: AccountConfig): boolean {
  return Boolean(
    (account.telegramSessionPath || account.telegramSessionString) &&
      account.telegramApiId &&
      account.telegramApiHash,
  );
}

function collectConfiguredTelegramIds(
  accounts: AccountConfig[],
  telegramAccounts: TelegramAccountConfig[],
): Set<string> {
  const configuredIds = new Set(telegramAccounts.map((acc) => acc.id));

  for (const account of accounts) {
    for (const tgAccount of normalizeTelegramAccountList(account.telegramConfig?.accounts)) {
      configuredIds.add(tgAccount.id);
    }
    if (hasLegacyTelegramBotConfig(account)) {
      configuredIds.add(`${account.id}_bot`);
    }
    if (hasLegacyTelegramClientConfig(account)) {
      configuredIds.add(account.id);
    }
  }

  return configuredIds;
}

function normalizeDiscordAccountLibrary(raw: any): DiscordAccountLibrary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (!item || typeof item !== "object") return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id : randomUUID(),
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "Discord 账号",
        remark: typeof item.remark === "string" && item.remark.trim() ? item.remark.trim() : undefined,
        type: item.type === "bot" ? "bot" : "selfbot",
        token: typeof item.token === "string" ? item.token : undefined,
        email: typeof item.email === "string" ? item.email : undefined,
        password: typeof item.password === "string" ? item.password : undefined,
        totpSecret: typeof item.totpSecret === "string" ? item.totpSecret : undefined,
        proxyUrl: typeof item.proxyUrl === "string" && item.proxyUrl.trim() ? item.proxyUrl.trim() : undefined,
        loginEnabled: item.loginEnabled !== false,
        syncedUser: item.syncedUser && typeof item.syncedUser === "object" ? item.syncedUser : undefined,
        lastSyncTime: typeof item.lastSyncTime === "string" ? item.lastSyncTime : undefined,
        guildsCount: typeof item.guildsCount === "number" ? item.guildsCount : undefined,
        channelsCount: typeof item.channelsCount === "number" ? item.channelsCount : undefined,
      };
    })
    .filter(Boolean) as DiscordAccountLibrary[];
}

function normalizeXAccountLibrary(raw: any): XAccountLibrary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (!item || typeof item !== "object") return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id : randomUUID(),
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "X 账号",
        remark: typeof item.remark === "string" && item.remark.trim() ? item.remark.trim() : undefined,
        apiKey: typeof item.apiKey === "string" ? item.apiKey : undefined,
        apiBaseUrl: typeof item.apiBaseUrl === "string" ? item.apiBaseUrl : undefined,
      };
    })
    .filter(Boolean) as XAccountLibrary[];
}

function normalizeTruthSocialAccountLibrary(raw: any): TruthSocialAccountLibrary[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (!item || typeof item !== "object") return null;
      return {
        id: typeof item.id === "string" && item.id.trim() ? item.id : randomUUID(),
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "TruthSocial 账号",
        username: typeof item.username === "string" ? item.username : undefined,
        password: typeof item.password === "string" ? item.password : undefined,
      };
    })
    .filter(Boolean) as TruthSocialAccountLibrary[];
}

function normalizeSafewAccounts(raw: any): SafewBotAccountConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const accounts: SafewBotAccountConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID();
    if (seen.has(id)) continue;
    const botToken = typeof item.botToken === "string" && item.botToken.trim() ? item.botToken.trim() : "";
    if (!botToken) continue;
    accounts.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "SafeW 机器人",
      botToken,
      loginState: typeof item.loginState === "string" ? item.loginState : "idle",
      loginMessage: typeof item.loginMessage === "string" ? item.loginMessage : "",
      groups: Array.isArray(item.groups)
        ? item.groups
            .map((group: any) => {
              if (!group || group.id === undefined || group.id === null) return null;
              return {
                id: String(group.id),
                title: typeof group.title === "string" && group.title.trim() ? group.title.trim() : "未命名群组",
                type: typeof group.type === "string" && group.type.trim() ? group.type.trim() : undefined,
              };
            })
            .filter(Boolean) as Array<{ id: string; title: string; type?: string }>
        : [],
    });
    seen.add(id);
  }
  return accounts;
}

function normalizeRuleConfigs(raw: any): Record<string, RuleLevelConfig> {
  const result: Record<string, RuleLevelConfig> = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [sourceId, config] of Object.entries(raw)) {
    result[sourceId] = normalizeRuleConfig(config);
  }
  return result;
}

function normalizeOptionalNumber(value: any): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && !isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function normalizeXMappings(raw: any): XForwardingRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (!item || typeof item !== "object") return null;
      const sourceUserName =
        typeof item.sourceUserName === "string" && item.sourceUserName.trim()
          ? item.sourceUserName.trim().replace(/^@+/, "")
          : undefined;
      const sourceUserId =
        typeof item.sourceUserId === "string" && item.sourceUserId.trim()
          ? item.sourceUserId.trim()
          : undefined;
      const targetWebhookUrl =
        typeof item.targetWebhookUrl === "string" && item.targetWebhookUrl.trim()
          ? item.targetWebhookUrl.trim()
          : "";
      if (!targetWebhookUrl || (!sourceUserName && !sourceUserId)) return null;
      const base = normalizeRuleConfig(item);
      return {
        ...base,
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID(),
        sourceUserName,
        sourceUserId,
        targetWebhookUrl,
        note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
        includeReplies: item.includeReplies === true,
        includeRetweets: item.includeRetweets === true,
        pollIntervalSeconds: normalizeOptionalNumber(item.pollIntervalSeconds),
      };
    })
    .filter(Boolean) as XForwardingRule[];
}

function normalizeXConfig(raw: any): XSourceConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined;
  const apiBaseUrl = typeof raw.apiBaseUrl === "string" && raw.apiBaseUrl.trim() ? raw.apiBaseUrl.trim() : undefined;
  const providerToken =
    typeof raw.sourceProvider === "string"
      ? raw.sourceProvider.trim().toLowerCase()
      : typeof raw.provider === "string"
        ? raw.provider.trim().toLowerCase()
        : "";
  const sourceProvider: XSourceProvider | undefined =
    providerToken === "twscrape" ? "twscrape" : providerToken === "twitterapi" || providerToken === "twitterapi.io" ? "twitterapi" : undefined;
  const twscrapeDbPath =
    typeof raw.twscrapeDbPath === "string" && raw.twscrapeDbPath.trim() ? raw.twscrapeDbPath.trim() : undefined;
  const modeRaw =
    typeof raw.mode === "string"
      ? raw.mode
      : typeof raw.streamMode === "string"
        ? raw.streamMode
        : undefined;
  const modeToken = typeof modeRaw === "string" ? modeRaw.trim().toLowerCase() : "";
  const mode: XStreamMode | undefined =
    modeToken === "websocket" || modeToken === "ws"
      ? "websocket"
      : modeToken === "poll" || modeToken === "polling"
        ? "poll"
        : undefined;
  const pollIntervalSeconds = normalizeOptionalNumber(raw.pollIntervalSeconds);
  const mappings = normalizeXMappings(raw.mappings);
  if (!apiKey && !apiBaseUrl && !sourceProvider && !twscrapeDbPath && !mode && !pollIntervalSeconds && mappings.length === 0) {
    return undefined;
  }
  return {
    apiKey,
    apiBaseUrl,
    sourceProvider,
    twscrapeDbPath,
    mode,
    pollIntervalSeconds,
    mappings,
  };
}

function normalizeTruthSocialMappings(raw: any): TruthSocialForwardingRule[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item: any) => {
      if (!item || typeof item !== "object") return null;
      const rawHandle =
        typeof item.sourceHandle === "string" && item.sourceHandle.trim()
          ? item.sourceHandle.trim()
          : "";
      const sourceHandle = rawHandle.replace(/^@+/, "");
      const targetWebhookUrl =
        typeof item.targetWebhookUrl === "string" && item.targetWebhookUrl.trim()
          ? item.targetWebhookUrl.trim()
          : "";
      if (!sourceHandle || !targetWebhookUrl) return null;
      const base = normalizeRuleConfig(item);
      return {
        ...base,
        id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID(),
        sourceHandle,
        targetWebhookUrl,
        note: typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined,
        pollIntervalSeconds: normalizeOptionalNumber(item.pollIntervalSeconds),
      };
    })
    .filter(Boolean) as TruthSocialForwardingRule[];
}

function normalizeTruthSocialConfig(raw: any): TruthSocialConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const username = typeof raw.username === "string" && raw.username.trim() ? raw.username.trim() : undefined;
  const password = typeof raw.password === "string" && raw.password.trim() ? raw.password : undefined;
  const pollIntervalSeconds = normalizeOptionalNumber(raw.pollIntervalSeconds);
  const mappings = normalizeTruthSocialMappings(raw.mappings);
  if (!username && !password && mappings.length === 0) {
    return undefined;
  }
  return {
    username,
    password,
    pollIntervalSeconds,
    mappings,
  };
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

function normalizeEnabledForwardingTypesForAdmin(types?: ForwardingType[]): ForwardingType[] {
  const source = Array.isArray(types) ? types : [];
  const defaultAllowed = new Set<ForwardingType>(DEFAULT_ENABLED_FORWARDING_TYPES);
  const allowed = source.filter((type) => defaultAllowed.has(type));
  return allowed.length > 0 ? allowed : [...DEFAULT_ENABLED_FORWARDING_TYPES];
}

function applyForwardingTypeRestrictions(
  accounts: AccountConfig[],
  allowedTypes?: ForwardingType[],
): AccountConfig[] {
  if (!allowedTypes || allowedTypes.length === 0) return accounts;
  return accounts.map((account) => {
    const current = account.forwardingType;
    if (current && allowedTypes.includes(current as ForwardingType)) {
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
  const discordAccountId =
    typeof input?.discordAccountId === "string" && input.discordAccountId.trim()
      ? input.discordAccountId.trim()
      : undefined;
  const telegramListenerAccountId =
    typeof input?.telegramListenerAccountId === "string" && input.telegramListenerAccountId.trim()
      ? input.telegramListenerAccountId.trim()
      : undefined;
  const telegramSenderAccountId =
    typeof input?.telegramSenderAccountId === "string" && input.telegramSenderAccountId.trim()
      ? input.telegramSenderAccountId.trim()
      : undefined;
  const xAccountId =
    typeof input?.xAccountId === "string" && input.xAccountId.trim()
      ? input.xAccountId.trim()
      : undefined;
  const truthSocialAccountId =
    typeof input?.truthSocialAccountId === "string" && input.truthSocialAccountId.trim()
      ? input.truthSocialAccountId.trim()
      : undefined;
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
  const feishuSourceGuildMap: Record<string, string> =
    input?.feishuSourceGuildMap && typeof input.feishuSourceGuildMap === "object"
      ? Object.fromEntries(
          Object.entries(input.feishuSourceGuildMap).map(([key, value]) => [String(key), String(value || "").trim()]),
        )
      : {};
  const feishuSourceChannelNameMap: Record<string, string> =
    input?.feishuSourceChannelNameMap && typeof input.feishuSourceChannelNameMap === "object"
      ? Object.fromEntries(
          Object.entries(input.feishuSourceChannelNameMap).map(([key, value]) => [String(key), String(value || "").trim()]),
        )
      : {};
  const feishuRuleConfigs = normalizeRuleConfigs(input?.feishuRuleConfigs);
  const feishuMappings = normalizeFeishuMappings(input);

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

  const feishuStyle: "style1" | "style2" | "style3" =
    input?.feishuStyle === "style3" ? "style3" : input?.feishuStyle === "style2" ? "style2" : "style1";
  const channelTranslate: Record<string, boolean> =
    input?.channelTranslate && typeof input.channelTranslate === "object" ? input.channelTranslate : {};
  const channelTranslateDirection: Record<string, "off" | "auto" | "zh-en" | "en-zh"> =
    input?.channelTranslateDirection && typeof input.channelTranslateDirection === "object" ? input.channelTranslateDirection : {};
  const sessionType: "file" | "string" = input?.sessionType === "string" ? "string" : "file";
  const accountWatermark = normalizeWatermarkConfig(input?.watermark);
  const accountWatermarkSecondary = normalizeWatermarkConfig(input?.watermarkSecondary);
  const accountWatermarks = mergeLegacyWatermarks(
    normalizeWatermarkList(input?.watermarks),
    accountWatermark,
    accountWatermarkSecondary,
  );
  const watermarkEnabled = input?.watermarkEnabled === false ? false : true;
  const watermarkRemoval = normalizeWatermarkRemovalConfig(input?.watermarkRemoval);
  const scheduledContents = normalizeScheduledContentList(input?.scheduledContents);
  const scheduledBroadcast = normalizeScheduledBroadcastConfig(input?.scheduledBroadcast);
  const mobileClientTarget = normalizeMobileClientTargetConfig(input?.mobileClientTarget);
  const discordLoginRaw = input?.discordLogin && typeof input.discordLogin === "object" ? input.discordLogin : {};
  const discordLoginEmail = typeof discordLoginRaw.email === "string" ? discordLoginRaw.email : input?.discordLoginEmail;
  const discordLoginPassword = typeof discordLoginRaw.password === "string" ? discordLoginRaw.password : input?.discordLoginPassword;
  const discordLoginTotp = typeof discordLoginRaw.totpSecret === "string" ? discordLoginRaw.totpSecret : input?.discordLoginTotpSecret;
  const discordLogin =
    (typeof discordLoginEmail === "string" && discordLoginEmail.trim()) ||
    (typeof discordLoginPassword === "string" && discordLoginPassword.trim()) ||
    (typeof discordLoginTotp === "string" && discordLoginTotp.trim())
      ? {
          email: typeof discordLoginEmail === "string" ? discordLoginEmail.trim() : undefined,
          password: typeof discordLoginPassword === "string" ? discordLoginPassword : undefined,
          totpSecret: typeof discordLoginTotp === "string" ? discordLoginTotp.trim() : undefined,
        }
      : undefined;
  const xConfig = normalizeXConfig(
    input?.xConfig && typeof input.xConfig === "object"
      ? input.xConfig
      : {
          apiKey: input?.xApiKey,
          apiBaseUrl: input?.xApiBaseUrl,
          pollIntervalSeconds: input?.xPollIntervalSeconds,
          mappings: input?.xMappings,
        },
  );
  const truthSocialConfig = normalizeTruthSocialConfig(
    input?.truthSocialConfig && typeof input.truthSocialConfig === "object"
      ? input.truthSocialConfig
      : {
          username: input?.truthSocialUsername,
          password: input?.truthSocialPassword,
          pollIntervalSeconds: input?.truthSocialPollIntervalSeconds,
          mappings: input?.truthSocialMappings,
        },
  );

  // 处理 Discord->Discord mappings（保留规则级别配置）
  const mappings: DiscordMappingRule[] = Array.isArray(input?.mappings)
    ? input.mappings.map((m: any) => {
        const normalizedRule = normalizeDiscordMappingRule(m);
        const watermark = normalizeWatermarkConfig(m.watermark);
        const watermarkSecondary = normalizeWatermarkConfig(m.watermarkSecondary);
        const watermarks = mergeLegacyWatermarks(normalizeWatermarkList(m.watermarks), watermark, watermarkSecondary);
        const watermarkRemoval = normalizeWatermarkRemovalConfig(m.watermarkRemoval);
        return {
          ...normalizedRule,
          mobileClientCategoryName:
            typeof m.mobileClientCategoryName === "string" && m.mobileClientCategoryName.trim()
              ? m.mobileClientCategoryName.trim()
              : undefined,
          mobileClientChannelName:
            typeof m.mobileClientChannelName === "string" && m.mobileClientChannelName.trim()
              ? m.mobileClientChannelName.trim()
              : undefined,
          mobileClientChannelAvatarUrl:
            typeof m.mobileClientChannelAvatarUrl === "string" && m.mobileClientChannelAvatarUrl.trim()
              ? m.mobileClientChannelAvatarUrl.trim()
              : undefined,
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
          showSourceIdentity: m.showSourceIdentity === true ? true : undefined,
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
          watermark,
          watermarkSecondary,
          watermarks,
          watermarkRemoval,
          scheduledBroadcast: normalizeScheduledBroadcastConfig(m.scheduledBroadcast),
          standbyMode: normalizeStandbyMode(m.standbyMode),
        };
      })
    : [];

  // 处理Telegram配置
  const telegramConfig: FrontendTelegramConfig | undefined = input?.telegramConfig && typeof input.telegramConfig === "object" ? {
    accounts: normalizeTelegramAccountList(input.telegramConfig.accounts),
    mappings: Array.isArray(input.telegramConfig.mappings)
      ? input.telegramConfig.mappings.map((mapping: any) => {
          const normalizedMapping = normalizeTelegramMapping(mapping);
          const watermark = normalizeWatermarkConfig(mapping.watermark);
          const watermarkSecondary = normalizeWatermarkConfig(mapping.watermarkSecondary);
          const watermarks = mergeLegacyWatermarks(
            normalizeWatermarkList(mapping.watermarks),
            watermark,
            watermarkSecondary,
          );
          const watermarkRemoval = normalizeWatermarkRemovalConfig(mapping.watermarkRemoval);
          const scheduledBroadcast = normalizeScheduledBroadcastConfig(mapping.scheduledBroadcast);
          return {
            ...normalizedMapping,
            mobileClientCategoryName:
              typeof mapping.mobileClientCategoryName === "string" && mapping.mobileClientCategoryName.trim()
                ? mapping.mobileClientCategoryName.trim()
                : undefined,
            mobileClientChannelName:
              typeof mapping.mobileClientChannelName === "string" && mapping.mobileClientChannelName.trim()
                ? mapping.mobileClientChannelName.trim()
                : undefined,
            mobileClientChannelAvatarUrl:
              typeof mapping.mobileClientChannelAvatarUrl === "string" && mapping.mobileClientChannelAvatarUrl.trim()
                ? mapping.mobileClientChannelAvatarUrl.trim()
                : undefined,
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
            showSourceIdentity: mapping.showSourceIdentity === true ? true : undefined,
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
            watermark,
            watermarkSecondary,
            watermarks,
            watermarkRemoval,
            scheduledBroadcast,
            standbyMode: normalizeStandbyMode(mapping.standbyMode),
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
    discordAccountId,
    telegramListenerAccountId,
    telegramSenderAccountId,
    xAccountId,
    truthSocialAccountId,
    channelWebhooks: input?.channelWebhooks || {},
    mappings,
    channelFeishuWebhooks,
    feishuRuleConfigs,
    feishuMappings,
    feishuSourceGuildMap,
    feishuSourceChannelNameMap,
    enableFeishuForward: input?.enableFeishuForward === true,
    enableDiscordForward: input?.enableDiscordForward !== false,
    feishuAppId: typeof input?.feishuAppId === "string" && input.feishuAppId.trim() ? input.feishuAppId.trim() : undefined,
    feishuAppSecret: typeof input?.feishuAppSecret === "string" && input.feishuAppSecret.trim() ? input.feishuAppSecret.trim() : undefined,
    safewBotToken: typeof input?.safewBotToken === "string" && input.safewBotToken.trim() ? input.safewBotToken.trim() : undefined,
    safewAccounts: normalizeSafewAccounts(input?.safewAccounts),
    channelNotes: input?.channelNotes || {},
    blockedKeywords: Array.isArray(input?.blockedKeywords) ? input.blockedKeywords : [],
    caseInsensitiveKeywords: true,
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
    watermark: accountWatermark,
    watermarkSecondary: accountWatermarkSecondary,
    watermarks: accountWatermarks,
    watermarkEnabled,
    scheduledContents,
    scheduledBroadcast,
    historyScan: input?.historyScan,
    mutedGuildsIds: input?.mutedGuildsIds || [],
    allowedGuildsIds: input?.allowedGuildsIds || [],
    mutedChannelsIds: input?.mutedChannelsIds || [],
    allowedChannelsIds: input?.allowedChannelsIds || [],
    allowedUsersIds: input?.allowedUsersIds || [],
    mutedUsersIds: input?.mutedUsersIds || [],
    allowedRoleIds: input?.allowedRoleIds || [],
    mutedRoleIds: input?.mutedRoleIds || [],
    channelConfigs: input?.channelConfigs || {},
    enableTranslation: input?.enableTranslation === true,
    deepseekApiKey: typeof input?.deepseekApiKey === "string" && input.deepseekApiKey.trim() ? input.deepseekApiKey.trim() : undefined,
    translationProvider: input?.translationProvider || "deepseek",
    translationApiKey: typeof input?.translationApiKey === "string" && input.translationApiKey.trim() ? input.translationApiKey.trim() : undefined,
    translationSecret: typeof input?.translationSecret === "string" && input.translationSecret.trim() ? input.translationSecret.trim() : undefined,
    translationBaseUrl: typeof input?.translationBaseUrl === "string" && input.translationBaseUrl.trim() ? input.translationBaseUrl.trim() : undefined,
    translationModel: typeof input?.translationModel === "string" && input.translationModel.trim() ? input.translationModel.trim() : undefined,
    translationPrompt: typeof input?.translationPrompt === "string" && input.translationPrompt.trim() ? input.translationPrompt.trim() : undefined,
    enableBotRelay: input?.enableBotRelay === true,
    botRelayToken: typeof input?.botRelayToken === "string" && input.botRelayToken.trim() ? input.botRelayToken.trim() : undefined,
    botRelayUseWebhook: input?.botRelayUseWebhook === true, // 兼容旧字段
    botRelayLoginState: typeof input?.botRelayLoginState === "string" ? input.botRelayLoginState : "idle",
    botRelayLoginMessage: typeof input?.botRelayLoginMessage === "string" ? input.botRelayLoginMessage : "",
    botRelays,
    channelRelayMap,
    ignoreSelf: input?.ignoreSelf === true,
    ignoreBot: input?.ignoreBot === true,
    onlyBot: input?.onlyBot === true,
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
    dedupeSequentialMessages: input?.dedupeSequentialMessages === true,
    ocrServerUrl: typeof input?.ocrServerUrl === "string" && input.ocrServerUrl.trim() ? input.ocrServerUrl.trim() : "http://localhost:9003",
    ocrBlockedKeywords: Array.isArray(input?.ocrBlockedKeywords) ? input.ocrBlockedKeywords : [],
    ocrTriggerKeywords: Array.isArray(input?.ocrTriggerKeywords) ? input.ocrTriggerKeywords : [],
    watermarkRemoval,
    discordLogin,

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
    xConfig,
    truthSocialConfig,
    telegramConfig,
    mobileClientTarget,
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

function ensureAccountLibraries(config: MultiConfig): { config: MultiConfig; changed: boolean } {
  let changed = false;
  const discordAccounts = Array.isArray(config.discordAccounts) ? [...config.discordAccounts] : [];
  const telegramAccounts = Array.isArray(config.telegramAccounts) ? [...config.telegramAccounts] : [];
  const xAccounts = Array.isArray(config.xAccounts) ? [...config.xAccounts] : [];
  const truthSocialAccounts = Array.isArray(config.truthSocialAccounts) ? [...config.truthSocialAccounts] : [];

  const discordIdSet = new Set(discordAccounts.map((acc) => acc.id));
  const telegramIdSet = new Set(telegramAccounts.map((acc) => acc.id));
  const xIdSet = new Set(xAccounts.map((acc) => acc.id));
  const truthIdSet = new Set(truthSocialAccounts.map((acc) => acc.id));

  const ensureUniqueId = (set: Set<string>, preferred?: string) => {
    if (preferred && !set.has(preferred)) return preferred;
    let id = randomUUID();
    while (set.has(id)) id = randomUUID();
    return id;
  };

  // Discord 账号库不再自动从实例凭据回填，完全由用户手动维护。
  if (clearDiscordLibraryReferences(config.accounts as any[], Array.from(discordIdSet))) {
    changed = true;
  }

  if (telegramAccounts.length === 0) {
    for (const account of config.accounts) {
      const sourceAccounts = normalizeTelegramAccountList(account.telegramConfig?.accounts);
      for (const tgAccount of sourceAccounts) {
        if (!tgAccount?.id || telegramIdSet.has(tgAccount.id)) continue;
        telegramAccounts.push({ ...tgAccount });
        telegramIdSet.add(tgAccount.id);
        changed = true;
      }

      const hasLegacyBot = hasLegacyTelegramBotConfig(account);
      if (hasLegacyBot && !telegramIdSet.has(`${account.id}_bot`)) {
        const botEntry: TelegramAccountConfig = {
          id: `${account.id}_bot`,
          name: `${account.name || "Telegram"} Bot`,
          type: "bot",
          token: account.telegramBotToken || "",
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          sessionType: account.sessionType,
          enabled: false,
        };
        telegramAccounts.push(botEntry);
        telegramIdSet.add(botEntry.id);
        changed = true;
      }

      const hasLegacyClient = hasLegacyTelegramClientConfig(account);
      if (hasLegacyClient && !telegramIdSet.has(account.id)) {
        const clientEntry: TelegramAccountConfig = {
          id: account.id,
          name: account.name || "Telegram Client",
          type: "client",
          token: account.telegramApiHash || "",
          sessionPath: account.telegramSessionPath,
          sessionString: account.telegramSessionString,
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          sessionType: account.sessionType,
          enabled: false,
        };
        telegramAccounts.push(clientEntry);
        telegramIdSet.add(clientEntry.id);
        changed = true;
      }

      if (!account.telegramListenerAccountId) {
        const listener =
          sourceAccounts.find((item) => item?.role === "listener") ||
          sourceAccounts.find((item) => item?.type === "client") ||
          sourceAccounts[0];
        if (listener?.id) {
          account.telegramListenerAccountId = listener.id;
          changed = true;
        } else if (hasLegacyClient) {
          account.telegramListenerAccountId = account.id;
          changed = true;
        } else if (hasLegacyBot) {
          account.telegramListenerAccountId = `${account.id}_bot`;
          changed = true;
        }
      }

      if (!account.telegramSenderAccountId) {
        const sender =
          sourceAccounts.find((item) => item?.role === "sender") ||
          sourceAccounts.find((item) => item?.type === "bot") ||
          sourceAccounts[0];
        if (sender?.id) {
          account.telegramSenderAccountId = sender.id;
          changed = true;
        } else if (hasLegacyBot) {
          account.telegramSenderAccountId = `${account.id}_bot`;
          changed = true;
        } else if (hasLegacyClient) {
          account.telegramSenderAccountId = account.id;
          changed = true;
        }
      }
    }
  }

  if (xAccounts.length === 0) {
    for (const account of config.accounts) {
      const xConfig = account.xConfig;
      if (!xConfig) continue;
      const hasCreds =
        (xConfig.apiKey && xConfig.apiKey.trim()) ||
        (xConfig.apiBaseUrl && xConfig.apiBaseUrl.trim());
      if (!hasCreds) continue;
      const entryId = ensureUniqueId(xIdSet, account.xAccountId);
      xAccounts.push({
        id: entryId,
        name: account.name ? `${account.name} X` : "X 账号",
        apiKey: xConfig.apiKey,
        apiBaseUrl: xConfig.apiBaseUrl,
      });
      xIdSet.add(entryId);
      if (!account.xAccountId) {
        account.xAccountId = entryId;
        changed = true;
      }
      changed = true;
    }
  }

  if (truthSocialAccounts.length === 0) {
    for (const account of config.accounts) {
      const truth = account.truthSocialConfig;
      if (!truth) continue;
      const hasCreds =
        (truth.username && truth.username.trim()) ||
        (truth.password && truth.password.trim());
      if (!hasCreds) continue;
      const entryId = ensureUniqueId(truthIdSet, account.truthSocialAccountId);
      truthSocialAccounts.push({
        id: entryId,
        name: account.name ? `${account.name} TruthSocial` : "TruthSocial 账号",
        username: truth.username,
        password: truth.password,
      });
      truthIdSet.add(entryId);
      if (!account.truthSocialAccountId) {
        account.truthSocialAccountId = entryId;
        changed = true;
      }
      changed = true;
    }
  }

  if (!config.discordAccounts || config.discordAccounts !== discordAccounts) {
    config.discordAccounts = discordAccounts;
    changed = true;
  }
  if (!config.telegramAccounts || config.telegramAccounts !== telegramAccounts) {
    config.telegramAccounts = telegramAccounts;
    changed = true;
  }
  if (!config.xAccounts || config.xAccounts !== xAccounts) {
    config.xAccounts = xAccounts;
    changed = true;
  }
  if (!config.truthSocialAccounts || config.truthSocialAccounts !== truthSocialAccounts) {
    config.truthSocialAccounts = truthSocialAccounts;
    changed = true;
  }

  return { config, changed };
}

export async function getMultiConfig(): Promise<MultiConfig> {
  const raw = await readRawConfig();
  const envForwardingTypes = parseEnvForwardingTypes(getEnv().ENABLED_FORWARDING_TYPES);
  const effectiveForwardingTypes = normalizeEnabledForwardingTypesForAdmin(envForwardingTypes);
  if (Array.isArray(raw?.accounts)) {
    const rawTelegramAccounts = Array.isArray(raw.telegramAccounts) ? raw.telegramAccounts : [];
    const hadTelegramLibraryPlaceholders = rawTelegramAccounts.some(
      (acc: any) => isTelegramAutoPlaceholderAccount(acc) || isTelegramPlaceholderName(acc?.name),
    );
    let hadTelegramConfigPlaceholders = false;
    for (const acc of raw.accounts) {
      const tgAccounts = acc?.telegramConfig?.accounts;
      if (Array.isArray(tgAccounts)) {
        if (tgAccounts.some((item: any) => isTelegramAutoPlaceholderAccount(item) || isTelegramPlaceholderName(item?.name))) {
          hadTelegramConfigPlaceholders = true;
          break;
        }
      }
    }
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
    const discordAccounts = normalizeDiscordAccountLibrary(raw.discordAccounts);
    const telegramAccounts = normalizeTelegramAccountList(raw.telegramAccounts);
    const xAccounts = normalizeXAccountLibrary(raw.xAccounts);
    const truthSocialAccounts = normalizeTruthSocialAccountLibrary(raw.truthSocialAccounts);

    // 迁移配置到最新版本
    const migratedAccounts = migrateAccountsToLatest(accounts, version);
    const config = {
      accounts: migratedAccounts,
      activeId: active,
      loginUser,
      loginPassword,
      telegramAvatarBaseUrl,
      discordAccounts,
      telegramAccounts,
      xAccounts,
      truthSocialAccounts,
      version: CONFIG_VERSION,
      enabledForwardingTypes: effectiveForwardingTypes,
    };

    const libraryResult = ensureAccountLibraries(config);
    const configuredTelegramIds = collectConfiguredTelegramIds(
      libraryResult.config.accounts,
      libraryResult.config.telegramAccounts || [],
    );
    let clearedTelegramRefs = false;
    libraryResult.config.accounts.forEach((account) => {
      if (account.telegramListenerAccountId && !configuredTelegramIds.has(account.telegramListenerAccountId)) {
        account.telegramListenerAccountId = "";
        clearedTelegramRefs = true;
      }
      if (account.telegramSenderAccountId && !configuredTelegramIds.has(account.telegramSenderAccountId)) {
        account.telegramSenderAccountId = "";
        clearedTelegramRefs = true;
      }
    });
    const shouldSave =
      version !== CONFIG_VERSION ||
      libraryResult.changed ||
      hadTelegramLibraryPlaceholders ||
      hadTelegramConfigPlaceholders ||
      clearedTelegramRefs;
    // 如果版本有更新或迁移了账号库，保存配置
    if (shouldSave) {
      await saveMultiConfig(libraryResult.config);
      if (version !== CONFIG_VERSION) {
        console.log(`Migrated config from version ${version} to ${CONFIG_VERSION}`);
      }
    }

    const restrictedAccounts = applyForwardingTypeRestrictions(migratedAccounts, effectiveForwardingTypes);
    return {
      ...libraryResult.config,
      accounts: restrictedAccounts,
      enabledForwardingTypes: effectiveForwardingTypes,
    };
  }
  const legacyConfig = migrateLegacyToMulti(raw);
  const legacyLibraryResult = ensureAccountLibraries(legacyConfig);
  const legacyRestrictedAccounts = applyForwardingTypeRestrictions(
    legacyConfig.accounts,
    effectiveForwardingTypes,
  );
  return {
    ...legacyLibraryResult.config,
    accounts: legacyRestrictedAccounts,
    enabledForwardingTypes: effectiveForwardingTypes,
  };
}

export async function saveMultiConfig(config: MultiConfig) {
  const { enabledForwardingTypes: _ignored, ...payload } = config;
  const content = JSON.stringify(payload, null, 2) + "\n";
  const tmpPath = path.join(path.dirname(CONFIG_PATH), `config.json.tmp-${randomUUID()}`);
  await backupConfigBeforeSave();
  await writeFile(tmpPath, content);
  await rename(tmpPath, CONFIG_PATH);
}

async function backupConfigBeforeSave() {
  if (!existsSync(CONFIG_PATH)) return;
  const backupDir = path.join(path.dirname(CONFIG_PATH), ".data", "config_backups");
  try {
    await mkdir(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(CONFIG_PATH, path.join(backupDir, `config-${timestamp}.json`));
    const backups = (await readdir(backupDir))
      .filter((name) => /^config-.*\.json$/.test(name))
      .sort();
    const staleBackups = backups.slice(0, Math.max(0, backups.length - CONFIG_BACKUP_LIMIT));
    await Promise.all(staleBackups.map((name) => unlink(path.join(backupDir, name)).catch(() => {})));
  } catch (error) {
    console.warn(`Failed to back up config before save: ${String((error as any)?.message || error)}`);
  }
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
      safewBotToken: undefined,
      safewAccounts: [],
      channelNotes: {},
      blockedKeywords: [],
      caseInsensitiveKeywords: true,
      excludeKeywords: [],
      ocrBlockedKeywords: [],
      ocrTriggerKeywords: [],
      watermarkRemoval: {
        enabled: false,
        mode: "ocr",
        provider: "iopaint",
        apiKey: undefined,
        triggerKeywords: [],
        iopaintModel: "lama",
        iopaintStrategy: "crop",
        iopaintMaskMode: "protect-text",
      },
      showSourceIdentity: false,
      publicBaseUrl: undefined,
      replacementsDictionary: {},
      watermark: undefined,
      watermarkSecondary: undefined,
      watermarks: undefined,
      scheduledContents: [],
      scheduledBroadcast: { enabled: false, intervalMinutes: 60, contentIds: [] },
      historyScan: { enabled: true },
      mutedGuildsIds: [],
      allowedGuildsIds: [],
      mutedChannelsIds: [],
      allowedChannelsIds: [],
      allowedUsersIds: [],
      mutedUsersIds: [],
      allowedRoleIds: [],
      mutedRoleIds: [],
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
      translationBaseUrl: undefined,
      translationModel: undefined,
      translationPrompt: undefined,
      enableBotRelay: false,
      botRelays: [],
      channelRelayMap: {},
      ignoreSelf: false,
      ignoreBot: false,
      onlyBot: false,
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
      dedupeSequentialMessages: false,
      feishuStyle: "style1",
      channelTranslate: {},
      channelTranslateDirection: {},
      mobileClientTarget: normalizeMobileClientTargetConfig(undefined),
    };
  }
  return {
    channelWebhooks: account.channelWebhooks,
    channelFeishuWebhooks: account.channelFeishuWebhooks,
    feishuMappings: account.feishuMappings,
    mappings: account.mappings,
    feishuRuleConfigs: account.feishuRuleConfigs,
    enableFeishuForward: account.enableFeishuForward,
    enableDiscordForward: account.enableDiscordForward,
    feishuAppId: account.feishuAppId,
    feishuAppSecret: account.feishuAppSecret,
    safewBotToken: account.safewBotToken,
    safewAccounts: account.safewAccounts,
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
    watermarkSecondary: account.watermarkSecondary,
    watermarks: account.watermarks,
    watermarkRemoval: account.watermarkRemoval,
    scheduledContents: account.scheduledContents,
    scheduledBroadcast: account.scheduledBroadcast,
    historyScan: account.historyScan,
    mutedGuildsIds: account.mutedGuildsIds,
    allowedGuildsIds: account.allowedGuildsIds,
    mutedChannelsIds: account.mutedChannelsIds,
    allowedChannelsIds: account.allowedChannelsIds,
    allowedUsersIds: account.allowedUsersIds,
    mutedUsersIds: account.mutedUsersIds,
    allowedRoleIds: account.allowedRoleIds,
    mutedRoleIds: account.mutedRoleIds,
    channelConfigs: account.channelConfigs,
    enableTranslation: account.enableTranslation,
    deepseekApiKey: account.deepseekApiKey,
    translationProvider: account.translationProvider,
    translationApiKey: account.translationApiKey,
    translationSecret: account.translationSecret,
    translationBaseUrl: account.translationBaseUrl,
    translationModel: account.translationModel,
    translationPrompt: account.translationPrompt,
    enableBotRelay: account.enableBotRelay,
    botRelays: account.botRelays,
    channelRelayMap: account.channelRelayMap,
    ignoreSelf: account.ignoreSelf,
    ignoreBot: account.ignoreBot,
    onlyBot: account.onlyBot,
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
    dedupeSequentialMessages: account.dedupeSequentialMessages,
    ocrServerUrl: account.ocrServerUrl,
    ocrBlockedKeywords: account.ocrBlockedKeywords,
    ocrTriggerKeywords: account.ocrTriggerKeywords,
    discordLogin: account.discordLogin,
    xConfig: account.xConfig,
    truthSocialConfig: account.truthSocialConfig,
    enableTelegramOverflow: (account as any).enableTelegramOverflow,
    telegramOverflowThreshold: (account as any).telegramOverflowThreshold,
    telegramOverflowMessage: (account as any).telegramOverflowMessage,
    feishuStyle: account.feishuStyle,
    channelTranslate: (account as any).channelTranslate || {},
    channelTranslateDirection: (account as any).channelTranslateDirection || {},
    mobileClientTarget: account.mobileClientTarget,
    telegramConfig: (account as any).telegramConfig,
  };
}

export async function getConfig(): Promise<LegacyConfig> {
  const multi = await getMultiConfig();
  return accountToLegacyConfig(multi.accounts[0]);
}

export function resolveMultiConfigForRuntime(config: MultiConfig): MultiConfig {
  const discordById = new Map((config.discordAccounts || []).map((acc) => [acc.id, acc]));
  const telegramById = new Map((config.telegramAccounts || []).map((acc) => [acc.id, acc]));
  const xById = new Map((config.xAccounts || []).map((acc) => [acc.id, acc]));
  const truthById = new Map((config.truthSocialAccounts || []).map((acc) => [acc.id, acc]));

  const accounts = config.accounts.map((account) => {
    let resolved: AccountConfig = { ...account };

    const discordAccount = account.discordAccountId ? discordById.get(account.discordAccountId) : undefined;
    if (discordAccount) {
      if (typeof discordAccount.token === "string" && discordAccount.token.trim()) {
        resolved.token = discordAccount.token;
      }
      resolved.type = discordAccount.type === "bot" ? "bot" : "selfbot";
      if (discordAccount.proxyUrl && !resolved.proxyUrl) {
        resolved.proxyUrl = discordAccount.proxyUrl;
      }
      if (discordAccount.email || discordAccount.password || discordAccount.totpSecret) {
        resolved.discordLogin = {
          email: discordAccount.email,
          password: discordAccount.password,
          totpSecret: discordAccount.totpSecret,
        };
      }
    }

    const selectedTelegramIds = [
      account.telegramListenerAccountId,
      account.telegramSenderAccountId,
    ].filter((id, idx, arr): id is string => !!id && arr.indexOf(id) === idx);
    if (selectedTelegramIds.length > 0) {
      const selectedAccounts: TelegramAccountConfig[] = [];
      for (const id of selectedTelegramIds) {
        const entry = telegramById.get(id);
        if (!entry) continue;
        const role =
          id === account.telegramSenderAccountId
            ? "sender"
            : id === account.telegramListenerAccountId
              ? "listener"
              : entry.role;
        selectedAccounts.push({ ...entry, role });
      }
      const listenerAccount = account.telegramListenerAccountId
        ? telegramById.get(account.telegramListenerAccountId)
        : undefined;
      const senderAccount = account.telegramSenderAccountId
        ? telegramById.get(account.telegramSenderAccountId)
        : undefined;
      const baseConfig = resolved.telegramConfig || { accounts: [], mappings: [], enableTelegramForward: false };
      const nextConfig: typeof baseConfig & {
        listenerAccountType?: "bot" | "client";
        defaultSenderAccountType?: "bot" | "client";
      } = {
        ...baseConfig,
        accounts: selectedAccounts,
      };
      if (listenerAccount?.type === "bot" || listenerAccount?.type === "client") {
        nextConfig.listenerAccountType = listenerAccount.type;
      }
      if (senderAccount?.type === "bot" || senderAccount?.type === "client") {
        nextConfig.defaultSenderAccountType = senderAccount.type;
      }
      resolved = {
        ...resolved,
        telegramConfig: nextConfig,
      };
    }

    const truthAccount = account.truthSocialAccountId ? truthById.get(account.truthSocialAccountId) : undefined;
    if (truthAccount) {
      const base = account.truthSocialConfig || { mappings: [] };
      resolved.truthSocialConfig = {
        ...base,
        username: truthAccount.username ?? base.username,
        password: truthAccount.password ?? base.password,
        mappings: base.mappings,
        pollIntervalSeconds: base.pollIntervalSeconds,
      };
    }

    const xAccount = account.xAccountId ? xById.get(account.xAccountId) : undefined;
    if (xAccount) {
      const base = account.xConfig || { mappings: [] };
      resolved.xConfig = {
        ...base,
        apiKey: xAccount.apiKey ?? base.apiKey,
        apiBaseUrl: xAccount.apiBaseUrl ?? base.apiBaseUrl,
        mappings: base.mappings,
        mode: base.mode,
        pollIntervalSeconds: base.pollIntervalSeconds,
      };
    }

    return resolved;
  });

  return { ...config, accounts };
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
