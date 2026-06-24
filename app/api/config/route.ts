import { NextRequest, NextResponse } from "next/server";
import { shouldPersistWatermarkRemovalConfig } from "@/src/watermarkRemoval";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  type AccountConfig,
  getMultiConfig,
  saveMultiConfig,
  type MultiConfig,
  type DiscordAccountLibrary,
  type TelegramAccountConfig,
  type TruthSocialAccountLibrary,
  type XAccountLibrary,
  type FeishuTargetConfig,
  type FrontendTelegramConfig,
  type RuleLevelConfig,
  type TruthSocialConfig,
  type WatermarkConfig,
  type WatermarkCoverConfig,
  type WatermarkRemovalConfig,
  type XSourceConfig,
  type ScheduledBroadcastConfig,
  type ScheduledContentItem,
} from "@/src/config";
import {
  getDiscordMetadataAccountId,
  normalizeDiscordSourceReference,
  resolveDiscordChannelMetadataFromCache,
  resolveDiscordChannelNameFromCache,
  resolveDiscordGuildNameFromCache,
} from "@/src/discordMetadataHelpers";
import { resolveDataPath } from "@/src/paths";
import { readDiscordLibraryStatus, readStatus, triggerFile } from "../_lib/common";
import { requireAuth } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const telegramStatusFile = resolveDataPath("telegram_status.json");
const externalStatusFile = resolveDataPath("external_forward_status.json");
const forwardStatsFile = resolveDataPath("forward_stats.json");
const discordGuildsCacheFile = resolveDataPath("discord_guilds_cache.json");
const discordChannelsCacheFile = resolveDataPath("discord_channels_cache.json");

const MASKED_SECRET = "********";

type TelegramStatusEntry = {
  state?: string;
  message?: string;
  userInfo?: any;
};

type ExternalRuleStatus = {
  lastPollAt?: number;
  lastSuccessAt?: number;
  lastForwardAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  lastItemId?: string;
};

type ExternalForwardStatusMap = {
  x?: Record<string, Record<string, ExternalRuleStatus>>;
  truthsocial?: Record<string, Record<string, ExternalRuleStatus>>;
};

type ForwardStatsSnapshot = {
  date?: string;
  total?: number;
  byType?: Record<string, number>;
  byAccount?: Record<string, number>;
  updatedAt?: number;
};

function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && value === MASKED_SECRET;
}

function resolveSecretValue(value: unknown, fallback?: string): string | undefined {
  if (value === undefined) return fallback;
  if (isMaskedSecret(value)) return fallback;
  if (typeof value === "string") return value;
  return fallback;
}

function maskSecret(value?: string): string {
  if (!value || !value.trim()) return "";
  return MASKED_SECRET;
}

function alignDiscordLinkedAccountTypes(config: MultiConfig): MultiConfig {
  const discordById = new Map((config.discordAccounts || []).map((account) => [account.id, account]));
  let changed = false;
  const accounts = (config.accounts || []).map((account) => {
    const discordAccountId =
      typeof (account as any).discordAccountId === "string" ? (account as any).discordAccountId.trim() : "";
    if (!discordAccountId) {
      return account;
    }
    const linked = discordById.get(discordAccountId);
    if (!linked) {
      return account;
    }
    const linkedType: "bot" | "selfbot" = linked.type === "bot" ? "bot" : "selfbot";
    if (account.type === linkedType) {
      return account;
    }
    changed = true;
    return {
      ...account,
      type: linkedType,
    };
  });

  return changed ? { ...config, accounts } : config;
}

async function readTelegramStatus(): Promise<Record<string, TelegramStatusEntry>> {
  try {
    const content = await fs.readFile(telegramStatusFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function readExternalForwardStatus(): Promise<ExternalForwardStatusMap> {
  try {
    const content = await fs.readFile(externalStatusFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function readJsonFileOr<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function getLocalDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function readForwardStats(): Promise<ForwardStatsSnapshot> {
  const today = getLocalDateKey();
  const fallback = { date: today, total: 0, byType: {}, byAccount: {} } as ForwardStatsSnapshot;
  try {
    const content = await fs.readFile(forwardStatsFile, "utf-8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return fallback;
    const date = typeof parsed.date === "string" ? parsed.date : today;
    if (date !== today) return fallback;
    const total =
      typeof parsed.total === "number" && Number.isFinite(parsed.total) ? parsed.total : 0;
    const byType = parsed.byType && typeof parsed.byType === "object" ? parsed.byType : {};
    const byAccount = parsed.byAccount && typeof parsed.byAccount === "object" ? parsed.byAccount : {};
    const updatedAt =
      typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : undefined;
    return { date, total, byType, byAccount, updatedAt };
  } catch {
    return fallback;
  }
}

function resolveTelegramAccountStatuses(
  account: AccountConfig,
  telegramStatus: Record<string, TelegramStatusEntry>,
  telegramLibraryById?: Map<string, TelegramAccountConfig>,
) {
  const selectedIds = [account.telegramListenerAccountId, account.telegramSenderAccountId].filter(
    (id, idx, arr): id is string => !!id && arr.indexOf(id) === idx,
  );
  const selectedAccounts = selectedIds
    .map((id) => telegramLibraryById?.get(id))
    .filter((item): item is TelegramAccountConfig => !!item);

  const telegramAccounts =
    selectedAccounts.length > 0 ? selectedAccounts : account.telegramConfig?.accounts || [];
  const activeAccounts = telegramAccounts.filter((acc) => acc.enabled !== false);

  const botAccount = activeAccounts.find((acc) => acc.type === "bot") || null;
  const clientAccount = activeAccounts.find((acc) => acc.type === "client") || null;

  const hasExplicitBot = telegramAccounts.some((acc) => acc.type === "bot");
  const hasExplicitClient = telegramAccounts.some((acc) => acc.type === "client");
  const hasLegacyBotConfig = Boolean(account.telegramBotToken);
  const hasLegacyClientConfig = Boolean(
    (account.telegramSessionPath || account.telegramSessionString) &&
      account.telegramApiId &&
      account.telegramApiHash,
  );

  const botAccountId =
    botAccount?.id || (!hasExplicitBot && hasLegacyBotConfig ? `${account.id}_bot` : undefined);
  const clientAccountId =
    clientAccount?.id || (!hasExplicitClient && hasLegacyClientConfig ? account.id : undefined);

  let botStatus = botAccountId ? telegramStatus[botAccountId] : undefined;
  let clientStatus = clientAccountId ? telegramStatus[clientAccountId] : undefined;

  if (clientStatus?.userInfo?.username?.toLowerCase().endsWith("bot")) {
    if (!botStatus) {
      botStatus = clientStatus;
    }
    clientStatus = undefined;
  }

  return {
    botStatus,
    clientStatus,
  };
}

function buildTelegramAccountStates(
  account: AccountConfig,
  telegramStatus: Record<string, TelegramStatusEntry>,
  telegramLibraryById?: Map<string, TelegramAccountConfig>,
) {
  const result: Record<string, { state?: string; message?: string; userInfo?: any }> = {};
  const selectedIds = [account.telegramListenerAccountId, account.telegramSenderAccountId].filter(
    (id, idx, arr): id is string => !!id && arr.indexOf(id) === idx,
  );
  const selectedAccounts = selectedIds
    .map((id) => telegramLibraryById?.get(id))
    .filter((item): item is TelegramAccountConfig => !!item);
  const accounts =
    selectedAccounts.length > 0 ? selectedAccounts : account.telegramConfig?.accounts || [];

  for (const item of accounts) {
    if (!item?.id) continue;
    if (item.enabled === false) {
      result[item.id] = {
        state: "idle",
        message: "未连接",
      };
      continue;
    }
    const status = telegramStatus[item.id];
    const normalizedState = normalizeTelegramState(status?.state);
    result[item.id] = {
      state: normalizedState,
      message: normalizeTelegramMessage(normalizedState, status?.message),
      userInfo: status?.userInfo,
    };
  }
  return result;
}

function normalizeTelegramState(state?: string): string {
  const value = String(state || "").toLowerCase();
  if (value === "connected" || value === "online") return "online";
  if (value === "connecting" || value === "pending") return "pending";
  if (value === "disconnected" || value === "idle") return "idle";
  if (value === "error") return "error";
  return state || "idle";
}

function normalizeDiscordState(state?: string): string {
  if (!state) return "idle";
  if (String(state).toLowerCase() === "stopped") return "idle";
  return state;
}

function normalizeTelegramMessage(state: string, message?: string): string {
  const trimmed = typeof message === "string" ? message.trim() : "";
  if (trimmed) return trimmed;
  if (state === "online") return "已连接";
  if (state === "pending") return "连接中";
  if (state === "error") return "连接异常";
  return "未连接";
}

interface FrontendMapping {
  id: string;
  sourceChannelId: string;
  sourceGuildId?: string;
  sourceGuildName?: string;
  sourceChannelName?: string;
  mobileClientCategoryName?: string;
  mobileClientChannelName?: string;
  mobileClientChannelAvatarUrl?: string;
  sourceThreadId?: string;
  targetWebhookUrl: string;
  targetChannelId?: string;
  targetGuildId?: string;
  discordSenderType?: "account" | "webhook";
  discordSenderAccountId?: string;
  showSourceIdentity?: boolean;
  hideDiscordLinks?: boolean;
  safewAccountId?: string;
  dingtalkSecret?: string;
  inputMode?: "manual" | "select";
  note?: string;
  // 是否开启翻译
  translate?: boolean;
  // 翻译方向: off = 关闭翻译, auto = 自动检测, zh-en = 中译英, en-zh = 英译中
  translateDirection?: "off" | "auto" | "zh-en" | "en-zh";
  // 超长消息处理（规则级别）
  longMessage?: {
    enabled: boolean;
    threshold?: number;
    appendMessage?: string;
  };
  // 规则级别的过滤配置
  allowedUsersIds?: string[];
  mutedUsersIds?: string[];
  allowedSenderNameKeywords?: string[];
  blockedSenderNameKeywords?: string[];
  blockedAuthorNameKeywords?: string[];
  blockedKeywords?: string[];
  excludeKeywords?: string[];
  ocrBlockedKeywords?: string[];
  ocrTriggerKeywords?: string[];
  replacementsDictionary?: Record<string, string>;
  // 规则级别的忽略配置
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
  dedupeSequentialMessages?: boolean;
  watermark?: WatermarkConfig;
  watermarkSecondary?: WatermarkConfig;
  watermarks?: WatermarkConfig[];
  watermarkEnabled?: boolean;
  watermarkRemoval?: WatermarkRemovalConfig;
  watermarkCover?: WatermarkCoverConfig;
  targetWebhookName?: string;
  targetWebhookAvatarUrl?: string;
  scheduledBroadcast?: ScheduledBroadcastConfig;
}

interface FrontendAccount {
  id: string;
  name: string;
  type: "bot" | "selfbot";
  forwardingType?:
    | "discord-to-discord"
    | "discord-to-telegram"
    | "discord-to-mobile-client"
    | "telegram-to-discord"
    | "telegram-to-telegram"
    | "telegram-to-mobile-client"
    | "telegram-to-dingtalk"
    | "discord-to-feishu"
    | "discord-to-dingtalk"
    | "discord-to-safew"
    | "x-to-discord"
    | "truthsocial-to-discord";
  token: string;
  proxyUrl: string;
  loginRequested: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  discordAccountId?: string;
  telegramListenerAccountId?: string;
  telegramSenderAccountId?: string;
  xAccountId?: string;
  truthSocialAccountId?: string;
  showSourceIdentity: boolean;
  mappings: FrontendMapping[];
  blockedKeywords: string[];
  caseInsensitiveKeywords?: boolean;
  excludeKeywords: string[];
  replacements: { from: string; to: string }[];
  allowedUsersIds: string[];
  mutedUsersIds: string[];
  allowedRoleIds?: string[];
  mutedRoleIds?: string[];
  restartNonce?: number;
  enableTranslation?: boolean;
  translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
  translationApiKey?: string;
  translationSecret?: string;
  translationBaseUrl?: string;
  translationModel?: string;
  translationPrompt?: string;
  deepseekApiKey?: string;
  enableBotRelay?: boolean;
  botRelays?: Array<{ id: string; name: string; token: string; loginState?: string; loginMessage?: string }>;
  channelRelayMap?: Record<string, string>;
  channelFeishuWebhooks?: Record<string, FeishuTargetConfig>;
  feishuMappings?: Array<RuleLevelConfig & {
    id?: string;
    sourceChannelId?: string;
    sourceGuildId?: string;
    sourceGuildName?: string;
    sourceChannelName?: string;
    target?: FeishuTargetConfig | string;
    note?: string;
    inputMode?: "select" | "manual";
  }>;
  feishuSourceGuildMap?: Record<string, string>;
  feishuSourceChannelNameMap?: Record<string, string>;
  enableFeishuForward?: boolean;
  enableDiscordForward?: boolean;
  feishuAppId?: string;
  feishuAppSecret?: string;
  safewBotToken?: string;
  safewAccounts?: Array<{ id: string; name: string; botToken: string; loginState?: string; loginMessage?: string; groups?: Array<{ id: string; title: string; type?: string }> }>;
  publicBaseUrl?: string;
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
  dedupeSequentialMessages?: boolean;
  watermark?: WatermarkConfig;
  watermarkSecondary?: WatermarkConfig;
  watermarks?: WatermarkConfig[];
  watermarkEnabled?: boolean;
  watermarkRemoval?: WatermarkRemovalConfig;
  watermarkCover?: WatermarkCoverConfig;
  scheduledContents?: ScheduledContentItem[];
  scheduledBroadcast?: ScheduledBroadcastConfig;
  // OCR 图片检测相关
  ocrServerUrl?: string;
  ocrBlockedKeywords?: string[];
  ocrTriggerKeywords?: string[];
  // Discord -> Discord 转发样式：style1 = 内嵌（默认），style2 = 纯文本 + 时间，style3 = 纯文本 + 时间（隐藏回复对象）
  feishuStyle?: "style1" | "style2" | "style3";
  // Telegram认证配置（用于Discord→Telegram）
  telegramBotToken?: string;
  // Telegram Client配置（用于Telegram→Discord）
  telegramApiId?: number | string;
  telegramApiHash?: string;
  telegramSessionPath?: string;
  telegramSessionString?: string;
  sessionType?: "file" | "string";
  telegramBotState?: string;
  telegramBotMessage?: string;
  telegramClientState?: string;
  telegramClientMessage?: string;
  telegramAccountStates?: Record<string, { state?: string; message?: string; userInfo?: any }>;
  // Telegram 超长消息处理配置
  enableTelegramOverflow?: boolean; // 是否启用Telegram超长消息处理
  telegramOverflowThreshold?: number; // 全局字数阈值
  telegramOverflowMessage?: string; // 全局超长时附加的消息
  // Telegram 配置（包含 accounts 和 mappings）
  telegramConfig?: FrontendTelegramConfig;
  mobileClientTarget?: any;
  feishuRuleConfigs?: Record<string, RuleLevelConfig>;
  discordLogin?: {
    email?: string;
    password?: string;
    totpSecret?: string;
  };
  xConfig?: XSourceConfig;
  truthSocialConfig?: TruthSocialConfig;
  externalForwardStatus?: {
    x?: Record<string, ExternalRuleStatus>;
    truthsocial?: Record<string, ExternalRuleStatus>;
  };
}

interface FrontendDiscordAccountLibrary
  extends Omit<DiscordAccountLibrary, "guildsCount" | "channelsCount"> {
  guildsCount?: number | string;
  channelsCount?: number | string;
  loginState?: string;
  loginMessage?: string;
}

interface FrontendTelegramAccountLibrary extends Omit<TelegramAccountConfig, "apiId" | "dialogsCount"> {
  apiId?: number | string;
  dialogsCount?: number | string;
  loginState?: string;
  loginMessage?: string;
  userInfo?: any;
}

interface FrontendXAccountLibrary extends XAccountLibrary {}

interface FrontendTruthSocialAccountLibrary extends TruthSocialAccountLibrary {}

interface FrontendPayload {
  accounts: FrontendAccount[];
  discordAccounts?: FrontendDiscordAccountLibrary[];
  telegramAccounts?: FrontendTelegramAccountLibrary[];
  xAccounts?: FrontendXAccountLibrary[];
  truthSocialAccounts?: FrontendTruthSocialAccountLibrary[];
  activeId?: string;
  loginUser?: string;
  loginPassword?: string;
  telegramAvatarBaseUrl?: string;
  forwardStats?: ForwardStatsSnapshot;
  enabledForwardingTypes?: Array<
    | "discord-to-discord"
    | "discord-to-telegram"
    | "discord-to-mobile-client"
    | "telegram-to-discord"
    | "telegram-to-telegram"
    | "telegram-to-mobile-client"
    | "telegram-to-dingtalk"
    | "discord-to-feishu"
    | "discord-to-dingtalk"
    | "discord-to-safew"
    | "x-to-discord"
    | "truthsocial-to-discord"
  >;
}

function normalizeFeishuTarget(raw: any): FeishuTargetConfig | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return { mode: "webhook", webhookUrl: trimmed };
  }
  if (!raw || typeof raw !== "object") return null;
  if (raw.mode === "thread") {
    const threadId = typeof raw.threadId === "string" ? raw.threadId.trim() : "";
    return { mode: "thread", threadId };
  }
  const webhookUrl = typeof raw.webhookUrl === "string" ? raw.webhookUrl.trim() : "";
  return { mode: "webhook", webhookUrl };
}

function normalizeFeishuTargets(raw: any): Record<string, FeishuTargetConfig> {
  const result: Record<string, FeishuTargetConfig> = {};
  if (!raw || typeof raw !== "object") return result;
  for (const [sourceId, target] of Object.entries(raw)) {
    const normalized = normalizeFeishuTarget(target);
    if (normalized) {
      result[sourceId] = normalized;
    }
  }
  return result;
}

function normalizeFeishuMappingRule(raw: any): any | null {
  if (!raw || typeof raw !== "object") return null;
  const target = normalizeFeishuTarget(raw.target || raw);
  if (!target) return null;
  const sourceChannelId = typeof raw.sourceChannelId === "string" ? raw.sourceChannelId.trim() : "";
  if (!sourceChannelId) return null;
  return {
    ...normalizeRuleConfig(raw),
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : randomUUID(),
    sourceChannelId,
    sourceGuildId: typeof raw.sourceGuildId === "string" && raw.sourceGuildId.trim() ? raw.sourceGuildId.trim() : undefined,
    sourceGuildName: typeof raw.sourceGuildName === "string" && raw.sourceGuildName.trim() ? raw.sourceGuildName.trim() : undefined,
    sourceChannelName:
      typeof raw.sourceChannelName === "string" && raw.sourceChannelName.trim() ? raw.sourceChannelName.trim() : undefined,
    target,
    note: typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined,
    inputMode: raw.inputMode === "manual" ? "manual" : raw.inputMode === "select" ? "select" : undefined,
  };
}

function normalizeFeishuMappings(raw: any): any[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => normalizeFeishuMappingRule(item)).filter(Boolean);
}

function normalizeFrontendWatermarkRemoval(raw: any): WatermarkRemovalConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const apiKey = typeof raw.apiKey === "string" && raw.apiKey.trim() ? raw.apiKey.trim() : undefined;
  const mode = raw.mode === "ocr" ? "ocr" : "always";
  const provider = raw.provider === "iopaint" ? "iopaint" : apiKey ? "wavespeed" : "iopaint";
  const triggerKeywords = Array.isArray(raw.triggerKeywords)
    ? raw.triggerKeywords.map((item: any) => String(item || "").trim()).filter(Boolean)
    : undefined;
  const iopaintModel = raw.iopaintModel === "migan" || raw.iopaintModel === "mat" ? raw.iopaintModel : "lama";
  const iopaintStrategy = raw.iopaintStrategy === "resize" || raw.iopaintStrategy === "original" ? raw.iopaintStrategy : "crop";
  const iopaintMaskMode = raw.iopaintMaskMode === "box" ? "box" : "protect-text";
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
        .filter(Boolean)
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

function normalizeFrontendWatermarkCover(raw: any): WatermarkCoverConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const regions = Array.isArray(raw.regions)
    ? raw.regions
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
          const color =
            typeof item.color === "string" && /^#?[0-9a-fA-F]{6}$/.test(item.color.trim())
              ? item.color.trim().startsWith("#")
                ? item.color.trim()
                : `#${item.color.trim()}`
              : undefined;
          const opacity = Number(item.opacity);
          const fillMode = item.fillMode === "auto" ? "auto" : "solid";
          const aspect =
            item.aspect === "landscape" || item.aspect === "portrait" || item.aspect === "square"
              ? item.aspect
              : "all";
          return {
            x: clampedX,
            y: clampedY,
            width: clampedWidth,
            height: clampedHeight,
            label,
            color,
            opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(100, Math.round(opacity))) : undefined,
            fillMode,
            aspect,
          };
        })
        .filter(Boolean)
    : undefined;
  const enabled = raw.enabled === true ? true : raw.enabled === false ? false : Boolean(regions && regions.length > 0);
  if (!enabled && raw.regions === undefined && raw.applyToImages === undefined && raw.applyToVideos === undefined) {
    return undefined;
  }
  return {
    enabled,
    applyToImages: raw.applyToImages === false ? false : true,
    applyToVideos: raw.applyToVideos === true,
    regions: regions && regions.length > 0 ? (regions as any) : [],
  };
}

function normalizeRuleConfig(raw: any): RuleLevelConfig {
  if (!raw || typeof raw !== "object") {
    return {
      allowedUsersIds: [],
      mutedUsersIds: [],
      allowedSenderNameKeywords: [],
      blockedSenderNameKeywords: [],
      blockedKeywords: [],
      excludeKeywords: [],
      ocrBlockedKeywords: [],
      ocrTriggerKeywords: [],
      longMessage: undefined,
      replacementsDictionary: {},
      showSourceIdentity: undefined,
      hideDiscordLinks: undefined,
      ignoreSelf: undefined,
      ignoreBot: undefined,
      onlyBot: undefined,
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
      watermarkCover: undefined,
      targetWebhookName: undefined,
      targetWebhookAvatarUrl: undefined,
      scheduledBroadcast: undefined,
      inputMode: undefined,
    };
  }
  const watermark = raw.watermark && typeof raw.watermark === "object" ? raw.watermark : undefined;
  const watermarkSecondary =
    raw.watermarkSecondary && typeof raw.watermarkSecondary === "object" ? raw.watermarkSecondary : undefined;
  const watermarks = resolveFrontendWatermarks(raw.watermarks, watermark, watermarkSecondary);
  const watermarkRemoval = normalizeFrontendWatermarkRemoval(raw.watermarkRemoval);
  const watermarkCover = normalizeFrontendWatermarkCover(raw.watermarkCover);
  const scheduledBroadcast = normalizeScheduledBroadcastConfig(raw.scheduledBroadcast);
  return {
    allowedUsersIds: Array.isArray(raw.allowedUsersIds) ? raw.allowedUsersIds.map(String).filter(Boolean) : [],
    mutedUsersIds: Array.isArray(raw.mutedUsersIds) ? raw.mutedUsersIds.map(String).filter(Boolean) : [],
    allowedSenderNameKeywords: Array.isArray(raw.allowedSenderNameKeywords) ? raw.allowedSenderNameKeywords.map(String).filter(Boolean) : [],
    blockedSenderNameKeywords: Array.isArray(raw.blockedSenderNameKeywords)
      ? raw.blockedSenderNameKeywords.map(String).filter(Boolean)
      : Array.isArray(raw.blockedAuthorNameKeywords)
        ? raw.blockedAuthorNameKeywords.map(String).filter(Boolean)
        : [],
    blockedAuthorNameKeywords: [],
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
    hideDiscordLinks: raw.hideDiscordLinks === true ? true : undefined,
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
    watermarkCover,
    targetWebhookName: typeof raw.targetWebhookName === "string" && raw.targetWebhookName.trim() ? raw.targetWebhookName.trim() : undefined,
    targetWebhookAvatarUrl: typeof raw.targetWebhookAvatarUrl === "string" && raw.targetWebhookAvatarUrl.trim() ? raw.targetWebhookAvatarUrl.trim() : undefined,
    scheduledBroadcast,
    inputMode:
      raw.inputMode === "manual" ? "manual" : raw.inputMode === "select" ? "select" : undefined,
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

function resolveFrontendWatermarks(
  list: unknown,
  primary?: WatermarkConfig,
  secondary?: WatermarkConfig,
): WatermarkConfig[] | undefined {
  if (Array.isArray(list)) return list as WatermarkConfig[];
  const legacy = [primary, secondary].filter((item): item is WatermarkConfig => !!item);
  return legacy.length > 0 ? legacy : undefined;
}

function normalizeScheduledContentItem(raw: any): ScheduledContentItem | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const id =
    typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : randomUUID();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
  const text = typeof raw.text === "string" ? raw.text : undefined;
  const mediaType = raw.mediaType === "image" || raw.mediaType === "video" ? raw.mediaType : undefined;
  const mediaSource = raw.mediaSource === "local" || raw.mediaSource === "url" ? raw.mediaSource : undefined;
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

function normalizeOptionalNumber(value: any): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() && !isNaN(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function mergeDiscordLogin(
  incoming?: { email?: string; password?: string; totpSecret?: string },
  fallback?: { email?: string; password?: string; totpSecret?: string },
) {
  if (!incoming && !fallback) return undefined;
  const email =
    typeof incoming?.email === "string" && incoming.email.trim()
      ? incoming.email.trim()
      : fallback?.email;
  const password = resolveSecretValue(incoming?.password, fallback?.password);
  const totpSecret = resolveSecretValue(incoming?.totpSecret, fallback?.totpSecret);
  if (!email && !password && !totpSecret) return undefined;
  return { email, password, totpSecret };
}

function mergeXConfig(incoming?: XSourceConfig, fallback?: XSourceConfig): XSourceConfig | undefined {
  if (!incoming && !fallback) return undefined;
  if (!incoming) return fallback;
  const next: XSourceConfig = { ...(fallback || {}), ...incoming };
  if ("apiKey" in incoming) {
    next.apiKey = resolveSecretValue(incoming.apiKey, fallback?.apiKey);
  }

  if (typeof incoming.apiBaseUrl === "string") {
    next.apiBaseUrl = incoming.apiBaseUrl.trim() || undefined;
  } else if (fallback?.apiBaseUrl) {
    next.apiBaseUrl = fallback.apiBaseUrl;
  }
  if (typeof (incoming as any).sourceProvider === "string") {
    const token = (incoming as any).sourceProvider.trim().toLowerCase();
    (next as any).sourceProvider =
      token === "twscrape" ? "twscrape" : token === "twitterapi" || token === "twitterapi.io" ? "twitterapi" : undefined;
  } else if ((fallback as any)?.sourceProvider) {
    (next as any).sourceProvider = (fallback as any).sourceProvider;
  }
  if (typeof (incoming as any).twscrapeDbPath === "string") {
    (next as any).twscrapeDbPath = (incoming as any).twscrapeDbPath.trim() || undefined;
  } else if ((fallback as any)?.twscrapeDbPath) {
    (next as any).twscrapeDbPath = (fallback as any).twscrapeDbPath;
  }
  if (typeof incoming.mode === "string") {
    const token = incoming.mode.trim().toLowerCase();
    next.mode = token === "websocket" || token === "ws" ? "websocket" : token === "poll" || token === "polling" ? "poll" : undefined;
  } else if (fallback?.mode) {
    next.mode = fallback.mode;
  }
  const pollIntervalSeconds = normalizeOptionalNumber(incoming.pollIntervalSeconds);
  next.pollIntervalSeconds = pollIntervalSeconds ?? fallback?.pollIntervalSeconds;

  if (Array.isArray(incoming.mappings)) {
    next.mappings = incoming.mappings;
  } else if (fallback?.mappings) {
    next.mappings = fallback.mappings;
  }

  const hasMappings = Array.isArray(next.mappings) && next.mappings.length > 0;
  const hasAny =
    !!next.apiKey ||
    !!next.apiBaseUrl ||
    !!(next as any).sourceProvider ||
    !!(next as any).twscrapeDbPath ||
    !!next.mode ||
    !!next.pollIntervalSeconds ||
    hasMappings;
  return hasAny ? next : undefined;
}

function mergeTruthSocialConfig(
  incoming?: TruthSocialConfig,
  fallback?: TruthSocialConfig,
): TruthSocialConfig | undefined {
  if (!incoming && !fallback) return undefined;
  if (!incoming) return fallback;
  const next: TruthSocialConfig = { ...(fallback || {}), ...incoming };
  if (typeof incoming.username === "string") {
    next.username = incoming.username.trim() || undefined;
  } else if (fallback?.username) {
    next.username = fallback.username;
  }
  if ("password" in incoming) {
    next.password = resolveSecretValue(incoming.password, fallback?.password);
  }
  const pollIntervalSeconds = normalizeOptionalNumber(incoming.pollIntervalSeconds);
  next.pollIntervalSeconds = pollIntervalSeconds ?? fallback?.pollIntervalSeconds;
  if (Array.isArray(incoming.mappings)) {
    next.mappings = incoming.mappings;
  } else if (fallback?.mappings) {
    next.mappings = fallback.mappings;
  }
  const hasMappings = Array.isArray(next.mappings) && next.mappings.length > 0;
  const hasAny = !!next.username || !!next.password || !!next.pollIntervalSeconds || hasMappings;
  return hasAny ? next : undefined;
}

function mergeTelegramConfig(
  incoming?: FrontendTelegramConfig,
  fallback?: FrontendTelegramConfig,
): FrontendTelegramConfig | undefined {
  if (!incoming && !fallback) return undefined;
  if (!incoming) return fallback;
  if (!fallback) return incoming;

  const incomingAccounts = Array.isArray(incoming.accounts) ? incoming.accounts : [];
  const fallbackAccounts = Array.isArray(fallback.accounts) ? fallback.accounts : [];
  const mergedAccountMap = new Map<string, any>();

  for (const acc of fallbackAccounts) {
    if (acc?.id) {
      mergedAccountMap.set(acc.id, { ...acc });
    }
  }

  for (const acc of incomingAccounts) {
    if (!acc?.id) continue;
    const prev = mergedAccountMap.get(acc.id);
    if (prev) {
      const merged = { ...prev, ...acc };
      if ("token" in acc) {
        merged.token = resolveSecretValue(acc.token, prev.token) ?? merged.token;
      }
      if ("apiHash" in acc) {
        merged.apiHash = resolveSecretValue(acc.apiHash, prev.apiHash) ?? merged.apiHash;
      }
      if ("sessionString" in acc) {
        merged.sessionString = resolveSecretValue(acc.sessionString, prev.sessionString) ?? merged.sessionString;
      }
      if ("twoFactorPassword" in acc) {
        merged.twoFactorPassword = resolveSecretValue((acc as any).twoFactorPassword, (prev as any).twoFactorPassword) ?? merged.twoFactorPassword;
      }
      if ("phoneNumber" in acc && (acc as any).phoneNumber) {
        merged.phoneNumber = (acc as any).phoneNumber;
      }
      if (acc.enabled === undefined && prev.enabled !== undefined) {
        merged.enabled = prev.enabled;
      }
      mergedAccountMap.set(acc.id, merged);
    } else {
      mergedAccountMap.set(acc.id, { ...acc });
    }
  }

  const hasIncomingDefaultSender = Object.prototype.hasOwnProperty.call(incoming, "defaultSenderAccountType");
  const normalizedDefaultSender = hasIncomingDefaultSender
    ? incoming.defaultSenderAccountType === "bot"
      ? "bot"
      : incoming.defaultSenderAccountType === "client"
        ? "client"
        : undefined
    : fallback.defaultSenderAccountType;
  const hasIncomingListener = Object.prototype.hasOwnProperty.call(incoming, "listenerAccountType");
  const normalizedListener = hasIncomingListener
    ? incoming.listenerAccountType === "bot"
      ? "bot"
      : incoming.listenerAccountType === "client"
        ? "client"
        : undefined
    : fallback.listenerAccountType;

  return {
    ...fallback,
    ...incoming,
    accounts: Array.from(mergedAccountMap.values()),
    mappings: Array.isArray(incoming.mappings) ? incoming.mappings : fallback.mappings,
    enableTelegramForward:
      typeof incoming.enableTelegramForward === "boolean"
        ? incoming.enableTelegramForward
        : fallback.enableTelegramForward,
    defaultSenderAccountType: normalizedDefaultSender,
    listenerAccountType: normalizedListener,
  };
}

function isMobileClientForwardingEnabled(account: AccountConfig | FrontendAccount): boolean {
  const forwardingType = account.forwardingType;
  if (forwardingType !== "discord-to-mobile-client" && forwardingType !== "telegram-to-mobile-client") {
    return false;
  }
  const target = (account as any).mobileClientTarget;
  return !target || typeof target !== "object" || target.enabled !== false;
}

function shouldExposeMobileClientSourceOnlyMapping(account: AccountConfig): boolean {
  return (
    (account.forwardingType === "discord-to-mobile-client" ||
      account.forwardingType === "telegram-to-mobile-client") &&
    isMobileClientForwardingEnabled(account)
  );
}

function shouldExposeMobileClientDraftMapping(account: AccountConfig, mapping: any): boolean {
  return (
    shouldExposeMobileClientSourceOnlyMapping(account) &&
    typeof mapping?.id === "string" &&
    mapping.id.trim().length > 0
  );
}

function mergeMobileClientTarget(dto: FrontendAccount, base: AccountConfig) {
  const incoming = (dto as any).mobileClientTarget;
  const fallback = (base as any).mobileClientTarget;
  const forwardingType = dto.forwardingType || base.forwardingType;
  if (incoming && typeof incoming === "object") {
    return {
      ...(fallback && typeof fallback === "object" ? fallback : {}),
      ...incoming,
      enabled: incoming.enabled === true,
    };
  }
  if (
    (forwardingType === "discord-to-mobile-client" || forwardingType === "telegram-to-mobile-client") &&
    (!fallback || typeof fallback !== "object")
  ) {
    return withDefaultMobileClientTarget({ enabled: true });
  }
  return fallback;
}

function resolveLinkedDiscordAccountId(dto: FrontendAccount, base: AccountConfig): string | undefined {
  if (typeof dto.discordAccountId === "string" && dto.discordAccountId.trim()) {
    return dto.discordAccountId.trim();
  }
  return base.discordAccountId;
}

function withDefaultMobileClientTarget(target: any) {
  return {
    enabled: target?.enabled === true,
    endpoint:
      typeof target?.endpoint === "string" && target.endpoint.trim()
        ? target.endpoint.trim().replace(/\/+$/, "")
        : process.env.MOBILE_CLIENT_SYNC_ENDPOINT || "http://192.210.141.219:8765",
    adminToken:
      typeof target?.adminToken === "string" && target.adminToken.trim()
        ? target.adminToken.trim()
        : process.env.MOBILE_CLIENT_SYNC_ADMIN_TOKEN || "jujing-admin-2026",
    guildId:
      typeof target?.guildId === "string" && target.guildId.trim()
        ? target.guildId.trim()
        : "mobile-client",
    guildName:
      typeof target?.guildName === "string" && target.guildName.trim()
        ? target.guildName.trim()
        : "手机客户端",
  };
}

function validateMobileClientCategoriesForStart(account: AccountConfig): { ok: true } | { ok: false; message: string } {
  const type = account.forwardingType;
  if (type !== "discord-to-mobile-client" && type !== "telegram-to-mobile-client") {
    return { ok: true };
  }

  const mappings =
    type === "telegram-to-mobile-client"
      ? ((account as any).telegramConfig?.mappings || []).filter((mapping: any) => mapping?.type === "telegram-to-mobile-client")
      : account.mappings || [];
  const activeMappings = mappings.filter((mapping: any) => String(mapping?.sourceChannelId || "").trim());
  if (activeMappings.length === 0) {
    return { ok: true };
  }

  const missing = activeMappings.some((mapping: any) => !String(mapping?.mobileClientCategoryName || "").trim());
  if (missing) {
    return { ok: false, message: "请先填写每条手机客户端规则的客户端分类" };
  }
  return { ok: true };
}

function accountToFrontend(
  account: AccountConfig,
  options?: {
    discordGuildsCache?: Record<string, any>;
    discordChannelsCache?: Record<string, any>;
    config?: MultiConfig;
  },
): FrontendAccount {
  const mappings: FrontendMapping[] = [];
  const channelTranslate: Record<string, boolean> = (account as any).channelTranslate || {};
  const channelTranslateDirection: Record<string, string> = (account as any).channelTranslateDirection || {};
  const metadataAccountId = getDiscordMetadataAccountId(account);
  const discordGuildsCache = options?.discordGuildsCache || {};
  const discordChannelsCache = options?.discordChannelsCache || {};

  // 获取后端保存的详细映射规则列表
  const savedMappings = (account as any).mappings || [];

  // 优先使用 savedMappings 数组（支持相同源ID的多个规则）
  if (savedMappings.length > 0) {
    for (const savedRule of savedMappings) {
      if (!savedRule?.sourceChannelId && !shouldExposeMobileClientDraftMapping(account, savedRule)) continue;
      if (!savedRule?.targetWebhookUrl && !(savedRule as any)?.targetChannelId && !shouldExposeMobileClientSourceOnlyMapping(account) && !shouldExposeMobileClientDraftMapping(account, savedRule)) continue;
      const sourceRef = normalizeDiscordSourceReference(
        String(savedRule.sourceChannelId),
        typeof savedRule.sourceGuildId === "string" ? savedRule.sourceGuildId : undefined,
      );
      const channelId = sourceRef.channelId;
      const resolvedFromCache = resolveDiscordChannelMetadataFromCache(
        discordChannelsCache,
        discordGuildsCache,
        metadataAccountId,
        channelId,
        options?.config,
        sourceRef.guildId,
      );
      const sourceGuildId = sourceRef.guildId || resolvedFromCache.guildId;
      const sourceGuildName =
        typeof savedRule.sourceGuildName === "string" && savedRule.sourceGuildName.trim()
          ? savedRule.sourceGuildName.trim()
          : resolvedFromCache.guildName ||
            resolveDiscordGuildNameFromCache(discordGuildsCache, metadataAccountId, sourceGuildId || "", options?.config);
      const sourceChannelNameBase =
        typeof savedRule.sourceChannelName === "string" && savedRule.sourceChannelName.trim()
          ? savedRule.sourceChannelName.trim()
          : resolvedFromCache.channelName ||
            resolveDiscordChannelNameFromCache(
              discordChannelsCache,
              metadataAccountId,
              sourceGuildId || "",
              channelId,
              options?.config,
            );
      const sourceChannelName =
        sourceChannelNameBase ||
        (typeof savedRule.note === "string" && savedRule.note.trim() ? savedRule.note.trim() : undefined);
      const resolvedWatermarks = resolveFrontendWatermarks(
        savedRule.watermarks,
        savedRule.watermark,
        savedRule.watermarkSecondary,
      );
      mappings.push({
        id: savedRule.id || channelId,
        sourceChannelId: channelId,
        sourceGuildId,
        sourceGuildName: sourceGuildName || undefined,
        sourceChannelName: sourceChannelName || undefined,
        mobileClientCategoryName:
          typeof (savedRule as any).mobileClientCategoryName === "string" && (savedRule as any).mobileClientCategoryName.trim()
            ? (savedRule as any).mobileClientCategoryName.trim()
            : undefined,
        mobileClientChannelName:
          typeof (savedRule as any).mobileClientChannelName === "string" && (savedRule as any).mobileClientChannelName.trim()
            ? (savedRule as any).mobileClientChannelName.trim()
            : undefined,
        mobileClientChannelAvatarUrl:
          typeof (savedRule as any).mobileClientChannelAvatarUrl === "string" &&
          (savedRule as any).mobileClientChannelAvatarUrl.trim()
            ? (savedRule as any).mobileClientChannelAvatarUrl.trim()
            : undefined,
        sourceThreadId:
          typeof (savedRule as any).sourceThreadId === "string" && (savedRule as any).sourceThreadId.trim()
            ? (savedRule as any).sourceThreadId.trim()
            : typeof (savedRule as any).sourceTopicId === "string" && (savedRule as any).sourceTopicId.trim()
              ? (savedRule as any).sourceTopicId.trim()
              : undefined,
        targetWebhookUrl: String(savedRule.targetWebhookUrl || ""),
        targetChannelId:
          typeof (savedRule as any).targetChannelId === "string" && (savedRule as any).targetChannelId.trim()
            ? (savedRule as any).targetChannelId.trim()
            : undefined,
        targetGuildId:
          typeof (savedRule as any).targetGuildId === "string" && (savedRule as any).targetGuildId.trim()
            ? (savedRule as any).targetGuildId.trim()
            : undefined,
        discordSenderType:
          (savedRule as any).discordSenderType === "account"
            ? "account"
            : (savedRule as any).discordSenderType === "webhook"
              ? "webhook"
              : undefined,
        discordSenderAccountId:
          typeof (savedRule as any).discordSenderAccountId === "string" &&
          (savedRule as any).discordSenderAccountId.trim()
            ? (savedRule as any).discordSenderAccountId.trim()
            : undefined,
        safewAccountId:
          typeof (savedRule as any).safewAccountId === "string" && (savedRule as any).safewAccountId.trim()
            ? (savedRule as any).safewAccountId.trim()
            : undefined,
        dingtalkSecret:
          typeof (savedRule as any).dingtalkSecret === "string" ? (savedRule as any).dingtalkSecret : undefined,
        inputMode:
          savedRule.inputMode === "manual"
            ? "manual"
            : savedRule.inputMode === "select"
              ? "select"
              : undefined,
        note: savedRule.note || account.channelNotes?.[channelId],
        targetWebhookName: typeof (savedRule as any).targetWebhookName === "string" ? (savedRule as any).targetWebhookName : undefined,
        targetWebhookAvatarUrl: typeof (savedRule as any).targetWebhookAvatarUrl === "string" ? (savedRule as any).targetWebhookAvatarUrl : undefined,
        translateDirection: !account.enableTranslation
          ? "off"
          : savedRule.translateDirection || (channelTranslateDirection[channelId] as any) || "auto",
        longMessage: savedRule.longMessage || (account as any).channelLongMessage?.[channelId] || { enabled: false },
        allowedUsersIds: (savedRule.allowedUsersIds || []).map(String),
        mutedUsersIds: (savedRule.mutedUsersIds || []).map(String),
        allowedSenderNameKeywords: (savedRule.allowedSenderNameKeywords || []).map(String),
        blockedSenderNameKeywords: (savedRule.blockedSenderNameKeywords || savedRule.blockedAuthorNameKeywords || []).map(String),
        blockedKeywords: savedRule.blockedKeywords || [],
        excludeKeywords: savedRule.excludeKeywords || [],
        ocrBlockedKeywords: savedRule.ocrBlockedKeywords || [],
        ocrTriggerKeywords: savedRule.ocrTriggerKeywords || [],
        replacementsDictionary: savedRule.replacementsDictionary || {},
        showSourceIdentity: savedRule.showSourceIdentity,
        hideDiscordLinks: savedRule.hideDiscordLinks,
        // 规则级别的忽略配置
        ignoreSelf: savedRule.ignoreSelf,
        ignoreBot: savedRule.ignoreBot,
        onlyBot: savedRule.onlyBot,
        ignoreImages: savedRule.ignoreImages,
        ignoreAudio: savedRule.ignoreAudio,
        ignoreVideo: savedRule.ignoreVideo,
        ignoreDocuments: savedRule.ignoreDocuments,
        ignoreEnglish: savedRule.ignoreEnglish,
        ignoreEnglishThreshold: savedRule.ignoreEnglishThreshold,
        ignoreChinese: savedRule.ignoreChinese,
        ignoreChineseThreshold: savedRule.ignoreChineseThreshold,
        stripEnglish: savedRule.stripEnglish,
        stripChinese: savedRule.stripChinese,
        watermark: savedRule.watermark,
        watermarkSecondary: savedRule.watermarkSecondary,
        watermarks: resolvedWatermarks,
        watermarkRemoval: normalizeFrontendWatermarkRemoval((savedRule as any).watermarkRemoval),
        watermarkCover: normalizeFrontendWatermarkCover((savedRule as any).watermarkCover),
        scheduledBroadcast: normalizeScheduledBroadcastConfig(savedRule.scheduledBroadcast),
      });
    }
  } else {
    // 兼容旧数据：从 channelWebhooks 对象读取
    for (const [channelId, webhookUrl] of Object.entries(account.channelWebhooks || {})) {
      mappings.push({
        id: channelId,
        sourceChannelId: channelId,
        targetWebhookUrl: webhookUrl,
        dingtalkSecret: undefined,
        inputMode: undefined,
        note: account.channelNotes?.[channelId],
        translateDirection: !account.enableTranslation
          ? "off"
          : (channelTranslateDirection[channelId] as any) || "auto",
        longMessage: (account as any).channelLongMessage?.[channelId] || { enabled: false },
        allowedUsersIds: [],
        mutedUsersIds: [],
        allowedSenderNameKeywords: [],
        blockedSenderNameKeywords: [],
        blockedKeywords: [],
        excludeKeywords: [],
        ocrBlockedKeywords: [],
        ocrTriggerKeywords: [],
        replacementsDictionary: {},
        watermark: undefined,
        watermarkSecondary: undefined,
        watermarks: undefined,
        watermarkRemoval: undefined,
        watermarkCover: undefined,
        scheduledBroadcast: undefined,
      });
    }
  }
  const replacements = Object.entries(account.replacementsDictionary || {}).map(([from, to]) => ({
    from,
    to: String(to ?? ""),
  }));

  return {
    id: account.id,
    name: account.name,
    type: account.type,
    forwardingType: (account as any).forwardingType || "discord-to-discord",
    token: account.token,
    proxyUrl: account.proxyUrl || "",
    loginRequested: account.loginRequested === true,
    loginNonce: account.loginNonce,
    loginState: account.loginState,
    loginMessage: account.loginMessage,
    discordAccountId: (account as any).discordAccountId,
    telegramListenerAccountId: (account as any).telegramListenerAccountId,
    telegramSenderAccountId: (account as any).telegramSenderAccountId,
    xAccountId: (account as any).xAccountId,
    truthSocialAccountId: (account as any).truthSocialAccountId,
    showSourceIdentity: account.showSourceIdentity === true,
    mappings,
    blockedKeywords: account.blockedKeywords || [],
    caseInsensitiveKeywords: account.caseInsensitiveKeywords !== false,
    excludeKeywords: account.excludeKeywords || [],
    replacements,
    allowedUsersIds: (account.allowedUsersIds || []).map((id: any) => String(id)),
    mutedUsersIds: (account.mutedUsersIds || []).map((id: any) => String(id)),
    allowedRoleIds: (account.allowedRoleIds || []).map((id: any) => String(id)),
    mutedRoleIds: (account.mutedRoleIds || []).map((id: any) => String(id)),
    restartNonce: account.restartNonce,
    enableTranslation: account.enableTranslation === true,
    translationProvider: account.translationProvider || "deepseek",
    translationApiKey: account.translationApiKey || account.deepseekApiKey || "",
    translationSecret: account.translationSecret || "",
    translationBaseUrl: account.translationBaseUrl || "",
    translationModel: account.translationModel || "",
    translationPrompt: account.translationPrompt || "",
    deepseekApiKey: account.deepseekApiKey || "",
    enableBotRelay: account.enableBotRelay === true,
    botRelays: account.botRelays || [],
    channelRelayMap: account.channelRelayMap || {},
    channelFeishuWebhooks: normalizeFeishuTargets(account.channelFeishuWebhooks),
    feishuMappings: normalizeFeishuMappings((account as any).feishuMappings),
    feishuSourceGuildMap: (account as any).feishuSourceGuildMap || {},
    feishuSourceChannelNameMap: (account as any).feishuSourceChannelNameMap || {},
    enableFeishuForward: account.enableFeishuForward === true,
    enableDiscordForward: account.enableDiscordForward !== false,
    mobileClientTarget:
      (account as any).forwardingType === "discord-to-mobile-client" ||
      (account as any).forwardingType === "telegram-to-mobile-client"
        ? withDefaultMobileClientTarget((account as any).mobileClientTarget || { enabled: true })
        : (account as any).mobileClientTarget,
    feishuAppId: account.feishuAppId || "",
    feishuAppSecret: account.feishuAppSecret || "",
    safewBotToken: (account as any).safewBotToken || "",
    safewAccounts: Array.isArray((account as any).safewAccounts) ? (account as any).safewAccounts : [],
    publicBaseUrl: account.publicBaseUrl || "",
    ignoreSelf: account.ignoreSelf === true,
    ignoreBot: account.ignoreBot === true,
    onlyBot: account.onlyBot === true,
    ignoreImages: account.ignoreImages === true,
    ignoreAudio: account.ignoreAudio === true,
    ignoreVideo: account.ignoreVideo === true,
    ignoreDocuments: account.ignoreDocuments === true,
    ignoreEnglish: account.ignoreEnglish === true,
    ignoreEnglishThreshold: account.ignoreEnglishThreshold,
    ignoreChinese: account.ignoreChinese === true,
    ignoreChineseThreshold: account.ignoreChineseThreshold,
    stripEnglish: account.stripEnglish === true,
    stripChinese: account.stripChinese === true,
    dedupeSequentialMessages: account.dedupeSequentialMessages === true,
    watermark: account.watermark,
    watermarkSecondary: account.watermarkSecondary,
    watermarks: resolveFrontendWatermarks(account.watermarks, account.watermark, account.watermarkSecondary),
    watermarkEnabled: account.watermarkEnabled !== false,
    watermarkRemoval:
      normalizeFrontendWatermarkRemoval(account.watermarkRemoval) || {
        enabled: false,
        mode: "ocr",
        provider: "iopaint",
        apiKey: "",
        triggerKeywords: [],
        iopaintModel: "lama",
        iopaintStrategy: "crop",
        iopaintMaskMode: "protect-text",
      },
    watermarkCover:
      normalizeFrontendWatermarkCover((account as any).watermarkCover) || {
        enabled: false,
        applyToImages: true,
        applyToVideos: false,
        regions: [],
      },
    scheduledContents: normalizeScheduledContentList(account.scheduledContents),
    scheduledBroadcast: normalizeScheduledBroadcastConfig(account.scheduledBroadcast),
    ocrServerUrl: account.ocrServerUrl || "http://localhost:9003",
    ocrBlockedKeywords: account.ocrBlockedKeywords || [],
    ocrTriggerKeywords: account.ocrTriggerKeywords || [],
    feishuStyle: account.feishuStyle || "style1",
    // Telegram认证配置
    telegramBotToken: (account as any).telegramBotToken || "",
    telegramApiId: (account as any).telegramApiId || undefined,
    telegramApiHash: (account as any).telegramApiHash || "",
    telegramSessionPath: (account as any).telegramSessionPath || "",
    telegramSessionString: (account as any).telegramSessionString || "",
    sessionType: (account as any).sessionType || "file",
    // Telegram 超长消息处理配置
    enableTelegramOverflow: (account as any).enableTelegramOverflow === true,
    telegramOverflowThreshold: (account as any).telegramOverflowThreshold || 0,
    telegramOverflowMessage: (account as any).telegramOverflowMessage || "",
    // Telegram 配置（包含 accounts 和 mappings）
    telegramConfig: (account as any).telegramConfig || undefined,
    feishuRuleConfigs: normalizeRuleConfigs((account as any).feishuRuleConfigs),
    discordLogin: account.discordLogin,
    xConfig: account.xConfig,
    truthSocialConfig: account.truthSocialConfig,
  };
}

function maskFrontendAccount(account: FrontendAccount): FrontendAccount {
  const masked: FrontendAccount = { ...account };
  masked.token = maskSecret(account.token);
  masked.translationApiKey = maskSecret(account.translationApiKey);
  masked.translationSecret = maskSecret(account.translationSecret);
  masked.deepseekApiKey = maskSecret(account.deepseekApiKey);
  masked.feishuAppSecret = maskSecret(account.feishuAppSecret);
  masked.safewBotToken = maskSecret(account.safewBotToken);
  if (Array.isArray(masked.safewAccounts)) {
    masked.safewAccounts = masked.safewAccounts.map((item) => ({
      ...item,
      botToken: maskSecret(item?.botToken),
    }));
  }
  if (masked.watermarkRemoval) {
    masked.watermarkRemoval = {
      ...masked.watermarkRemoval,
      apiKey: maskSecret(masked.watermarkRemoval.apiKey),
    };
  }
  masked.telegramBotToken = maskSecret(account.telegramBotToken);
  masked.telegramApiHash = maskSecret(account.telegramApiHash);
  masked.telegramSessionString = maskSecret(account.telegramSessionString);
  if (masked.discordLogin) {
    masked.discordLogin = {
      ...masked.discordLogin,
      password: maskSecret(masked.discordLogin.password),
      totpSecret: maskSecret(masked.discordLogin.totpSecret),
    };
  }
  if (masked.xConfig) {
    masked.xConfig = {
      ...masked.xConfig,
      apiKey: maskSecret(masked.xConfig.apiKey),
    };
  }
  if (masked.truthSocialConfig) {
    masked.truthSocialConfig = {
      ...masked.truthSocialConfig,
      password: maskSecret(masked.truthSocialConfig.password),
    };
  }

  if (Array.isArray(masked.mappings)) {
    masked.mappings = masked.mappings.map((mapping) => ({
      ...mapping,
      dingtalkSecret: maskSecret(mapping?.dingtalkSecret),
    }));
  }

  if (Array.isArray(masked.botRelays)) {
    masked.botRelays = masked.botRelays.map((relay) => ({
      ...relay,
      token: maskSecret(relay?.token),
    }));
  }

  if (masked.telegramConfig && Array.isArray(masked.telegramConfig.accounts)) {
    masked.telegramConfig = {
      ...masked.telegramConfig,
      accounts: masked.telegramConfig.accounts.map((acc) => ({
        ...acc,
        token: maskSecret(acc?.token),
        apiHash: maskSecret(acc?.apiHash),
        sessionString: maskSecret(acc?.sessionString),
        twoFactorPassword: maskSecret((acc as any)?.twoFactorPassword),
      })),
    };
  }

  return masked;
}

function maskDiscordLibraryAccount(account: FrontendDiscordAccountLibrary): FrontendDiscordAccountLibrary {
  return {
    ...account,
    token: maskSecret(account.token),
    password: maskSecret(account.password),
    totpSecret: maskSecret(account.totpSecret),
  };
}

function maskTelegramLibraryAccount(account: FrontendTelegramAccountLibrary): FrontendTelegramAccountLibrary {
  return {
    ...account,
    token: maskSecret(account.token),
    apiHash: maskSecret(account.apiHash),
    sessionString: maskSecret(account.sessionString),
    twoFactorPassword: maskSecret(account.twoFactorPassword),
  };
}

function maskXLibraryAccount(account: FrontendXAccountLibrary): FrontendXAccountLibrary {
  return {
    ...account,
    apiKey: maskSecret(account.apiKey),
  };
}

function maskTruthLibraryAccount(account: FrontendTruthSocialAccountLibrary): FrontendTruthSocialAccountLibrary {
  return {
    ...account,
    password: maskSecret(account.password),
  };
}

function dtoToDiscordLibraryAccount(
  dto: FrontendDiscordAccountLibrary,
  fallback?: DiscordAccountLibrary,
): DiscordAccountLibrary {
  const base: DiscordAccountLibrary = fallback ?? {
    id: randomUUID(),
    name: "Discord 账号",
    type: "selfbot",
  };
  const resolvedToken = resolveSecretValue(dto.token, base.token);
  const resolvedPassword = resolveSecretValue(dto.password, base.password);
  const resolvedTotp = resolveSecretValue(dto.totpSecret, base.totpSecret);
  const guildsCount =
    typeof dto.guildsCount === "number"
      ? dto.guildsCount
      : typeof dto.guildsCount === "string" && dto.guildsCount.trim() && !isNaN(Number(dto.guildsCount))
        ? Number(dto.guildsCount)
        : base.guildsCount;
  const channelsCount =
    typeof dto.channelsCount === "number"
      ? dto.channelsCount
      : typeof dto.channelsCount === "string" && dto.channelsCount.trim() && !isNaN(Number(dto.channelsCount))
        ? Number(dto.channelsCount)
        : base.channelsCount;
  const loginEnabled =
    dto.loginEnabled === false
      ? false
      : dto.loginEnabled === true
        ? true
        : base.loginEnabled !== false;
  return {
    ...base,
    id: typeof dto.id === "string" && dto.id.trim() ? dto.id.trim() : base.id,
    name: typeof dto.name === "string" && dto.name.trim() ? dto.name.trim() : base.name,
    remark: typeof dto.remark === "string" && dto.remark.trim() ? dto.remark.trim() : base.remark,
    type: dto.type === "bot" ? "bot" : "selfbot",
    token: typeof resolvedToken === "string" && resolvedToken.trim() ? resolvedToken : undefined,
    email: typeof dto.email === "string" && dto.email.trim() ? dto.email.trim() : base.email,
    password: typeof resolvedPassword === "string" && resolvedPassword.trim() ? resolvedPassword : undefined,
    totpSecret: typeof resolvedTotp === "string" && resolvedTotp.trim() ? resolvedTotp : undefined,
    proxyUrl: typeof dto.proxyUrl === "string" && dto.proxyUrl.trim() ? dto.proxyUrl.trim() : base.proxyUrl,
    loginEnabled,
    syncedUser: typeof dto.syncedUser === "object" && dto.syncedUser ? dto.syncedUser : base.syncedUser,
    lastSyncTime:
      typeof dto.lastSyncTime === "string" && dto.lastSyncTime.trim() ? dto.lastSyncTime.trim() : base.lastSyncTime,
    guildsCount,
    channelsCount,
  };
}

function dtoToTelegramLibraryAccount(
  dto: FrontendTelegramAccountLibrary,
  fallback?: TelegramAccountConfig,
): TelegramAccountConfig {
  const base: TelegramAccountConfig = fallback ?? {
    id: randomUUID(),
    name: "",
    type: "client",
    token: "",
  };
  const resolvedToken = resolveSecretValue(dto.token, base.token);
  const resolvedApiHash = resolveSecretValue(dto.apiHash, base.apiHash);
  const resolvedSessionString = resolveSecretValue(dto.sessionString, base.sessionString);
  const resolvedTwoFactor = resolveSecretValue(dto.twoFactorPassword, base.twoFactorPassword);
  const apiId =
    typeof dto.apiId === "number"
      ? dto.apiId
      : typeof dto.apiId === "string" && dto.apiId.trim() && !isNaN(Number(dto.apiId))
        ? Number(dto.apiId)
        : base.apiId;
  const dialogsCount =
    typeof dto.dialogsCount === "number"
      ? dto.dialogsCount
      : typeof dto.dialogsCount === "string" && dto.dialogsCount.trim() && !isNaN(Number(dto.dialogsCount))
        ? Number(dto.dialogsCount)
        : base.dialogsCount;
  return {
    ...base,
    id: typeof dto.id === "string" && dto.id.trim() ? dto.id.trim() : base.id,
    name: typeof dto.name === "string" && dto.name.trim() ? dto.name.trim() : base.name,
    remark: typeof dto.remark === "string" && dto.remark.trim() ? dto.remark.trim() : base.remark,
    type: dto.type === "bot" ? "bot" : "client",
    token: typeof resolvedToken === "string" ? resolvedToken : "",
    sessionPath: typeof dto.sessionPath === "string" && dto.sessionPath.trim() ? dto.sessionPath.trim() : base.sessionPath,
    sessionString:
      typeof resolvedSessionString === "string" && resolvedSessionString.trim()
        ? resolvedSessionString
        : base.sessionString,
    apiId,
    apiHash: typeof resolvedApiHash === "string" && resolvedApiHash.trim() ? resolvedApiHash : base.apiHash,
    phoneNumber: typeof dto.phoneNumber === "string" && dto.phoneNumber.trim() ? dto.phoneNumber.trim() : base.phoneNumber,
    twoFactorPassword: typeof resolvedTwoFactor === "string" && resolvedTwoFactor.trim() ? resolvedTwoFactor : base.twoFactorPassword,
    role: dto.role === "listener" || dto.role === "sender" ? dto.role : base.role,
    sessionType: dto.sessionType === "string" ? "string" : dto.sessionType === "file" ? "file" : base.sessionType,
    loginRequested: dto.loginRequested === true,
    loginNonce: typeof dto.loginNonce === "number" ? dto.loginNonce : base.loginNonce,
    loginState: typeof dto.loginState === "string" ? dto.loginState : base.loginState,
    loginMessage: typeof dto.loginMessage === "string" ? dto.loginMessage : base.loginMessage,
    enabled: dto.enabled !== false,
    syncedUser: typeof dto.syncedUser === "object" && dto.syncedUser ? dto.syncedUser : base.syncedUser,
    lastSyncTime:
      typeof dto.lastSyncTime === "string" && dto.lastSyncTime.trim() ? dto.lastSyncTime.trim() : base.lastSyncTime,
    dialogsCount,
  };
}

function dtoToXLibraryAccount(
  dto: FrontendXAccountLibrary,
  fallback?: XAccountLibrary,
): XAccountLibrary {
  const base: XAccountLibrary = fallback ?? {
    id: randomUUID(),
    name: "X 账号",
  };
  const resolvedApiKey = resolveSecretValue(dto.apiKey, base.apiKey);
  return {
    ...base,
    id: typeof dto.id === "string" && dto.id.trim() ? dto.id.trim() : base.id,
    name: typeof dto.name === "string" && dto.name.trim() ? dto.name.trim() : base.name,
    remark: typeof dto.remark === "string" && dto.remark.trim() ? dto.remark.trim() : base.remark,
    apiKey: typeof resolvedApiKey === "string" && resolvedApiKey.trim() ? resolvedApiKey : base.apiKey,
    apiBaseUrl: typeof dto.apiBaseUrl === "string" && dto.apiBaseUrl.trim() ? dto.apiBaseUrl.trim() : base.apiBaseUrl,
  };
}

function dtoToTruthLibraryAccount(
  dto: FrontendTruthSocialAccountLibrary,
  fallback?: TruthSocialAccountLibrary,
): TruthSocialAccountLibrary {
  const base: TruthSocialAccountLibrary = fallback ?? {
    id: randomUUID(),
    name: "TruthSocial 账号",
  };
  const resolvedPassword = resolveSecretValue(dto.password, base.password);
  return {
    ...base,
    id: typeof dto.id === "string" && dto.id.trim() ? dto.id.trim() : base.id,
    name: typeof dto.name === "string" && dto.name.trim() ? dto.name.trim() : base.name,
    remark: typeof dto.remark === "string" && dto.remark.trim() ? dto.remark.trim() : base.remark,
    username: typeof dto.username === "string" && dto.username.trim() ? dto.username.trim() : base.username,
    password: typeof resolvedPassword === "string" && resolvedPassword.trim() ? resolvedPassword : base.password,
  };
}

function dtoToAccount(dto: FrontendAccount, fallback?: AccountConfig): AccountConfig {
  const base: AccountConfig =
    fallback ??
    ({
      id: randomUUID(),
      name: dto.name || "未命名转发实例",
      type: dto.type === "bot" ? "bot" : "selfbot",
      forwardingType: dto.forwardingType || "discord-to-discord",
      token: dto.token || "",
      proxyUrl: dto.proxyUrl || "",
      channelWebhooks: {},
      channelFeishuWebhooks: {},
      enableFeishuForward: false,
      enableDiscordForward: true,
      feishuAppId: "",
      feishuAppSecret: "",
      safewAccounts: [],
      publicBaseUrl: "",
      channelNotes: {},
      blockedKeywords: [],
      excludeKeywords: [],
      showSourceIdentity: dto.showSourceIdentity === true,
      replacementsDictionary: {},
      historyScan: { enabled: true },
      showChat: true,
      enableTranslation: dto.enableTranslation === true,
      translationProvider: dto.translationProvider || "deepseek",
      translationApiKey: dto.translationApiKey || dto.deepseekApiKey || "",
      translationSecret: dto.translationSecret || "",
      deepseekApiKey: dto.deepseekApiKey || "",
      enableBotRelay: dto.enableBotRelay === true,
      botRelays: [],
      channelRelayMap: {},
      ignoreSelf: dto.ignoreSelf === true,
      ignoreBot: dto.ignoreBot === true,
      ignoreImages: dto.ignoreImages === true,
      ignoreAudio: dto.ignoreAudio === true,
      ignoreVideo: dto.ignoreVideo === true,
      ignoreDocuments: dto.ignoreDocuments === true,
      ignoreEnglish: dto.ignoreEnglish === true,
      ignoreEnglishThreshold: dto.ignoreEnglishThreshold,
      ignoreChinese: dto.ignoreChinese === true,
      ignoreChineseThreshold: dto.ignoreChineseThreshold,
      stripEnglish: dto.stripEnglish === true,
      stripChinese: dto.stripChinese === true,
      dedupeSequentialMessages: dto.dedupeSequentialMessages === true,
      watermarkRemoval: {
        enabled: false,
        mode: "ocr",
        provider: "iopaint",
        apiKey: "",
        triggerKeywords: [],
        iopaintModel: "lama",
        iopaintStrategy: "crop",
        iopaintMaskMode: "protect-text",
      },
      watermarkCover: {
        enabled: false,
        applyToImages: true,
        applyToVideos: false,
        regions: [],
      },
      feishuStyle: "style1",
    } as AccountConfig);

  const channelWebhooks: Record<string, string> = {};
  const channelNotes: Record<string, string> = {};
  const channelTranslate: Record<string, boolean> = {};
  const channelTranslateDirection: Record<string, "off" | "auto" | "zh-en" | "en-zh"> = {};
  const channelLongMessage: Record<string, { enabled: boolean; threshold?: number; appendMessage?: string }> = {};
  // 保存完整的 mappings 数组（包含规则级别配置）
  const savedMappings: any[] = [];
  const feishuRuleConfigs = normalizeRuleConfigs(
    dto.feishuRuleConfigs && typeof dto.feishuRuleConfigs === "object"
      ? dto.feishuRuleConfigs
      : (base as any).feishuRuleConfigs,
  );
  const baseDingTalkSecretById = new Map<string, string | undefined>();
  const baseDingTalkSecretByKey = new Map<string, string | undefined>();
  for (const item of base.mappings || []) {
    if (!item) continue;
    if (item.id) {
      baseDingTalkSecretById.set(item.id, (item as any).dingtalkSecret);
    }
    const source = String((item as any).sourceChannelId || "").trim();
    const target = String((item as any).targetWebhookUrl || "").trim();
    if (source && target) {
      baseDingTalkSecretByKey.set(`${source}::${target}`, (item as any).dingtalkSecret);
    }
  }

  function shouldKeepMobileClientSourceOnlyMapping(accountDto: FrontendAccount): boolean {
    return (
      (accountDto.forwardingType === "discord-to-mobile-client" ||
        accountDto.forwardingType === "telegram-to-mobile-client") &&
      isMobileClientForwardingEnabled(accountDto)
    );
  }

  function shouldKeepMobileClientDraftMapping(accountDto: FrontendAccount, mapping: any): boolean {
    return (
      shouldKeepMobileClientSourceOnlyMapping(accountDto) &&
      typeof mapping?.id === "string" &&
      mapping.id.trim().length > 0
    );
  }

  function shouldKeepDiscordDraftMapping(mapping: any): boolean {
    return (
      typeof mapping?.id === "string" &&
      mapping.id.trim().length > 0 &&
      typeof mapping?.sourceChannelId === "string" &&
      mapping.sourceChannelId.trim().length > 0
    );
  }

  if (Array.isArray(dto.mappings)) {
    for (const mapping of dto.mappings) {
      const sourceRef = normalizeDiscordSourceReference(
        typeof mapping?.sourceChannelId === "string" ? mapping.sourceChannelId : "",
        typeof mapping?.sourceGuildId === "string" ? mapping.sourceGuildId : undefined,
      );
      const key = sourceRef.channelId;
      const targetWebhookUrl = String(mapping?.targetWebhookUrl || "").trim();
      const targetChannelId = String((mapping as any)?.targetChannelId || "").trim();
      const shouldKeepDraftMapping =
        shouldKeepMobileClientDraftMapping(dto, mapping) || shouldKeepDiscordDraftMapping(mapping);
      if ((key || shouldKeepDraftMapping) && (targetWebhookUrl || targetChannelId || shouldKeepMobileClientSourceOnlyMapping(dto) || shouldKeepDraftMapping)) {
        if (targetWebhookUrl) {
          channelWebhooks[key] = targetWebhookUrl;
        }
        if (typeof mapping.note === "string" && mapping.note.trim()) {
          channelNotes[key] = mapping.note.trim();
        }
        if (mapping.translateDirection) {
          // 明确设置翻译方向，包括"off"
            channelTranslateDirection[key] = mapping.translateDirection as any;
          if (mapping.translateDirection !== "off") {
            // 开启翻译时，设置启用状态
            channelTranslate[key] = true;
          } else {
            // 关闭翻译时，确保启用状态为false
            channelTranslate[key] = false;
          }
        }
        // Telegram 超长消息处理
        if (mapping.longMessage) {
          channelLongMessage[key] = {
            enabled: mapping.longMessage.enabled || false,
            threshold: typeof mapping.longMessage.threshold === "number" ? mapping.longMessage.threshold : undefined,
            appendMessage: typeof mapping.longMessage.appendMessage === "string" ? mapping.longMessage.appendMessage.trim() : undefined,
          };
        }

        // 保存完整的规则配置
        const mappingWatermarks = resolveFrontendWatermarks(
          mapping.watermarks,
          mapping.watermark,
          mapping.watermarkSecondary,
        );
        const fallbackDingTalkSecret =
          (typeof mapping.id === "string" && mapping.id
            ? baseDingTalkSecretById.get(mapping.id)
            : undefined) ||
          (targetWebhookUrl ? baseDingTalkSecretByKey.get(`${key}::${targetWebhookUrl}`) : undefined);
        const resolvedDingTalkSecret = resolveSecretValue(mapping.dingtalkSecret, fallbackDingTalkSecret);
        savedMappings.push({
          id: mapping.id || randomUUID(),
          sourceChannelId: key,
          sourceGuildId: sourceRef.guildId,
          sourceGuildName:
            typeof mapping.sourceGuildName === "string" && mapping.sourceGuildName.trim()
              ? mapping.sourceGuildName.trim()
              : undefined,
          sourceChannelName:
            typeof mapping.sourceChannelName === "string" && mapping.sourceChannelName.trim()
              ? mapping.sourceChannelName.trim()
              : undefined,
          mobileClientCategoryName:
            typeof mapping.mobileClientCategoryName === "string" && mapping.mobileClientCategoryName.trim()
              ? mapping.mobileClientCategoryName.trim()
              : undefined,
          mobileClientChannelName:
            typeof mapping.mobileClientChannelName === "string" && mapping.mobileClientChannelName.trim()
              ? mapping.mobileClientChannelName.trim()
              : undefined,
          mobileClientChannelAvatarUrl:
            typeof (mapping as any).mobileClientChannelAvatarUrl === "string" &&
            (mapping as any).mobileClientChannelAvatarUrl.trim()
              ? (mapping as any).mobileClientChannelAvatarUrl.trim()
              : undefined,
          sourceThreadId:
            typeof (mapping as any).sourceThreadId === "string" && (mapping as any).sourceThreadId.trim()
              ? (mapping as any).sourceThreadId.trim()
              : typeof (mapping as any).sourceTopicId === "string" && (mapping as any).sourceTopicId.trim()
                ? (mapping as any).sourceTopicId.trim()
                : undefined,
          targetWebhookUrl,
          targetChannelId: targetChannelId || undefined,
          targetGuildId:
            typeof mapping.targetGuildId === "string" && mapping.targetGuildId.trim()
              ? mapping.targetGuildId.trim()
              : undefined,
          discordSenderType:
            mapping.discordSenderType === "account"
              ? "account"
              : mapping.discordSenderType === "webhook"
                ? "webhook"
                : undefined,
          discordSenderAccountId:
            typeof mapping.discordSenderAccountId === "string" && mapping.discordSenderAccountId.trim()
              ? mapping.discordSenderAccountId.trim()
              : undefined,
          safewAccountId:
            typeof (mapping as any).safewAccountId === "string" && (mapping as any).safewAccountId.trim()
              ? (mapping as any).safewAccountId.trim()
              : undefined,
          dingtalkSecret:
            typeof resolvedDingTalkSecret === "string" && resolvedDingTalkSecret.trim()
              ? resolvedDingTalkSecret.trim()
              : undefined,
          inputMode:
            mapping.inputMode === "manual"
              ? "manual"
              : mapping.inputMode === "select"
                ? "select"
                : undefined,
          note: mapping.note,
          targetWebhookName:
            typeof mapping.targetWebhookName === "string" && mapping.targetWebhookName.trim()
              ? mapping.targetWebhookName.trim()
              : undefined,
          targetWebhookAvatarUrl:
            typeof mapping.targetWebhookAvatarUrl === "string" && mapping.targetWebhookAvatarUrl.trim()
              ? mapping.targetWebhookAvatarUrl.trim()
              : undefined,
          translateDirection: mapping.translateDirection,
          longMessage: mapping.longMessage,
          allowedUsersIds: mapping.allowedUsersIds || [],
          mutedUsersIds: mapping.mutedUsersIds || [],
          allowedSenderNameKeywords: mapping.allowedSenderNameKeywords || [],
          blockedSenderNameKeywords: mapping.blockedSenderNameKeywords || mapping.blockedAuthorNameKeywords || [],
          blockedKeywords: mapping.blockedKeywords || [],
          excludeKeywords: mapping.excludeKeywords || [],
          ocrBlockedKeywords: mapping.ocrBlockedKeywords || [],
          ocrTriggerKeywords: mapping.ocrTriggerKeywords || [],
          replacementsDictionary: mapping.replacementsDictionary || {},
          showSourceIdentity: mapping.showSourceIdentity,
          hideDiscordLinks: mapping.hideDiscordLinks,
          // 规则级别的忽略配置
          ignoreSelf: mapping.ignoreSelf,
          ignoreBot: mapping.ignoreBot,
          onlyBot: mapping.onlyBot,
          ignoreImages: mapping.ignoreImages,
          ignoreAudio: mapping.ignoreAudio,
          ignoreVideo: mapping.ignoreVideo,
          ignoreDocuments: mapping.ignoreDocuments,
          ignoreEnglish: mapping.ignoreEnglish,
          ignoreEnglishThreshold: mapping.ignoreEnglishThreshold,
          ignoreChinese: mapping.ignoreChinese,
          ignoreChineseThreshold: mapping.ignoreChineseThreshold,
          stripEnglish: mapping.stripEnglish,
          stripChinese: mapping.stripChinese,
          watermark: mapping.watermark,
          watermarkSecondary: mapping.watermarkSecondary,
          watermarks: mappingWatermarks,
          watermarkRemoval: normalizeFrontendWatermarkRemoval(mapping.watermarkRemoval),
          watermarkCover: normalizeFrontendWatermarkCover(mapping.watermarkCover),
          scheduledBroadcast: normalizeScheduledBroadcastConfig(mapping.scheduledBroadcast),
        });
      }
    }
  }

  const replacementsDictionary: Record<string, string> = {};
  if (Array.isArray(dto.replacements)) {
    for (const rule of dto.replacements) {
      if (rule?.from) {
        replacementsDictionary[String(rule.from)] = String(rule.to ?? "");
      }
    }
  }
  const channelFeishuWebhooks = normalizeFeishuTargets(dto.channelFeishuWebhooks);
  const feishuMappings = normalizeFeishuMappings((dto as any).feishuMappings);
  const shouldPreserveFeishuTargets =
    (dto.forwardingType || base.forwardingType) === "discord-to-feishu" &&
    fallback?.loginRequested === true &&
    Object.keys(channelFeishuWebhooks).length === 0 &&
    feishuMappings.length === 0 &&
    Object.keys(base.channelFeishuWebhooks || {}).length > 0;
  const feishuSourceGuildMap =
    dto.feishuSourceGuildMap && typeof dto.feishuSourceGuildMap === "object"
      ? Object.fromEntries(
          Object.entries(dto.feishuSourceGuildMap).map(([key, value]) => [String(key), String(value || "").trim()]),
        )
      : base.feishuSourceGuildMap || {};
  const feishuSourceChannelNameMap =
    dto.feishuSourceChannelNameMap && typeof dto.feishuSourceChannelNameMap === "object"
      ? Object.fromEntries(
          Object.entries(dto.feishuSourceChannelNameMap).map(([key, value]) => [String(key), String(value || "").trim()]),
        )
      : base.feishuSourceChannelNameMap || {};
  const mergedTelegramConfig = mergeTelegramConfig(
    dto.telegramConfig && typeof dto.telegramConfig === "object" ? dto.telegramConfig : undefined,
    base.telegramConfig,
  );
  const baseRelayMap = new Map<string, any>();
  for (const relay of base.botRelays || []) {
    if (relay?.id) {
      baseRelayMap.set(relay.id, relay);
    }
  }

  const nextBotRelays = Array.isArray(dto.botRelays)
    ? dto.botRelays
        .map((x: any) => {
          if (!x) return null;
          const fallbackRelay = x.id ? baseRelayMap.get(x.id) : undefined;
          const resolvedToken = resolveSecretValue(x.token, fallbackRelay?.token);
          if (typeof resolvedToken !== "string" || !resolvedToken.trim()) return null;
          return {
            id: typeof x.id === "string" && x.id.trim() ? x.id.trim() : randomUUID(),
            name: typeof x.name === "string" && x.name.trim() ? x.name.trim() : "中转机器人",
            token: resolvedToken.trim(),
            loginState: typeof x.loginState === "string" ? x.loginState : fallbackRelay?.loginState || "idle",
            loginMessage: typeof x.loginMessage === "string" ? x.loginMessage : fallbackRelay?.loginMessage || "",
          };
        })
        .filter(Boolean)
    : base.botRelays || [];

  const baseSafewAccountMap = new Map<string, any>();
  for (const item of ((base as any).safewAccounts || [])) {
    if (item?.id) {
      baseSafewAccountMap.set(item.id, item);
    }
  }
  const nextSafewAccounts = Array.isArray((dto as any).safewAccounts)
    ? ((dto as any).safewAccounts as any[])
        .map((item: any) => {
          if (!item) return null;
          const fallbackAccount = item.id ? baseSafewAccountMap.get(item.id) : undefined;
          const resolvedToken = resolveSecretValue(item.botToken, fallbackAccount?.botToken);
          if (typeof resolvedToken !== "string" || !resolvedToken.trim()) return null;
          return {
            id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : randomUUID(),
            name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "SafeW 机器人",
            botToken: resolvedToken.trim(),
            loginState: typeof item.loginState === "string" ? item.loginState : fallbackAccount?.loginState || "idle",
            loginMessage: typeof item.loginMessage === "string" ? item.loginMessage : fallbackAccount?.loginMessage || "",
            groups: Array.isArray(item.groups) ? item.groups : Array.isArray(fallbackAccount?.groups) ? fallbackAccount.groups : [],
          };
        })
        .filter(Boolean)
    : (base as any).safewAccounts || [];

  const resolvedAccountWatermarks = resolveFrontendWatermarks(
    dto.watermarks,
    dto.watermark,
    dto.watermarkSecondary,
  );
  const resolvedAccountWatermarkRemoval = {
    ...base.watermarkRemoval,
    ...normalizeFrontendWatermarkRemoval(dto.watermarkRemoval),
    apiKey: resolveSecretValue(dto.watermarkRemoval?.apiKey, base.watermarkRemoval?.apiKey),
  };
  if (dto.watermarkRemoval?.enabled === false) {
    resolvedAccountWatermarkRemoval.enabled = false;
  }
  const resolvedAccountWatermarkCover =
    normalizeFrontendWatermarkCover(dto.watermarkCover) ?? normalizeFrontendWatermarkCover((base as any).watermarkCover);
  const resolvedScheduledContents = normalizeScheduledContentList(dto.scheduledContents);
  const resolvedScheduledBroadcast = normalizeScheduledBroadcastConfig(dto.scheduledBroadcast);
  const mergedDiscordLogin = mergeDiscordLogin(dto.discordLogin, base.discordLogin);
  const mergedXConfig = mergeXConfig(dto.xConfig, base.xConfig);
  const mergedTruthSocialConfig = mergeTruthSocialConfig(dto.truthSocialConfig, base.truthSocialConfig);

  let loginRequested: boolean;
  if (fallback && fallback.loginRequested === true) {
    loginRequested = dto.loginRequested === false ? false : true;
  } else {
    loginRequested = dto.loginRequested === true;
  }

  const nextAccount: AccountConfig = {
    ...base,
    id: dto.id || base.id,
    name: dto.name || base.name,
    type: dto.type === "bot" ? "bot" : "selfbot",
    forwardingType: dto.forwardingType || base.forwardingType || "discord-to-discord",
    token: resolveSecretValue(dto.token, base.token) || "",
    proxyUrl: dto.proxyUrl || "",
    loginRequested,
    loginNonce: dto.loginNonce ?? base.loginNonce,
    discordAccountId: resolveLinkedDiscordAccountId(dto, base),
    telegramListenerAccountId:
      typeof dto.telegramListenerAccountId === "string" && dto.telegramListenerAccountId.trim()
        ? dto.telegramListenerAccountId.trim()
        : base.telegramListenerAccountId,
    telegramSenderAccountId:
      typeof dto.telegramSenderAccountId === "string" && dto.telegramSenderAccountId.trim()
        ? dto.telegramSenderAccountId.trim()
        : base.telegramSenderAccountId,
    xAccountId:
      typeof dto.xAccountId === "string" && dto.xAccountId.trim()
        ? dto.xAccountId.trim()
        : base.xAccountId,
    truthSocialAccountId:
      typeof dto.truthSocialAccountId === "string" && dto.truthSocialAccountId.trim()
        ? dto.truthSocialAccountId.trim()
        : base.truthSocialAccountId,
    showSourceIdentity: dto.showSourceIdentity === true,
    channelWebhooks,
    mappings: savedMappings,
    mobileClientTarget: mergeMobileClientTarget(dto, base),
    channelFeishuWebhooks: shouldPreserveFeishuTargets ? base.channelFeishuWebhooks || {} : channelFeishuWebhooks,
    feishuMappings: shouldPreserveFeishuTargets ? (base as any).feishuMappings || [] : feishuMappings,
    feishuSourceGuildMap,
    feishuSourceChannelNameMap,
    feishuRuleConfigs,
    enableFeishuForward: shouldPreserveFeishuTargets ? true : dto.enableFeishuForward === true,
    enableDiscordForward: dto.enableDiscordForward !== false,
    feishuAppId: typeof dto.feishuAppId === "string" && dto.feishuAppId.trim() ? dto.feishuAppId.trim() : base.feishuAppId,
    feishuAppSecret:
      typeof resolveSecretValue(dto.feishuAppSecret, base.feishuAppSecret) === "string" &&
      resolveSecretValue(dto.feishuAppSecret, base.feishuAppSecret)!.trim()
        ? resolveSecretValue(dto.feishuAppSecret, base.feishuAppSecret)!.trim()
        : base.feishuAppSecret,
    safewBotToken:
      typeof resolveSecretValue(dto.safewBotToken, (base as any).safewBotToken) === "string" &&
      resolveSecretValue(dto.safewBotToken, (base as any).safewBotToken)!.trim()
        ? resolveSecretValue(dto.safewBotToken, (base as any).safewBotToken)!.trim()
        : (base as any).safewBotToken,
    safewAccounts: nextSafewAccounts,
    publicBaseUrl:
      typeof dto.publicBaseUrl === "string" && dto.publicBaseUrl.trim()
        ? dto.publicBaseUrl.trim()
        : base.publicBaseUrl,
    channelNotes,
    channelTranslate,
    channelTranslateDirection,
    channelLongMessage,
    blockedKeywords: Array.isArray(dto.blockedKeywords) ? dto.blockedKeywords : [],
    caseInsensitiveKeywords: true,
    excludeKeywords: Array.isArray(dto.excludeKeywords) ? dto.excludeKeywords : [],
    replacementsDictionary,
    allowedUsersIds: Array.isArray(dto.allowedUsersIds) ? dto.allowedUsersIds : base.allowedUsersIds || [],
    mutedUsersIds: Array.isArray(dto.mutedUsersIds) ? dto.mutedUsersIds : base.mutedUsersIds || [],
    allowedRoleIds: Array.isArray(dto.allowedRoleIds) ? dto.allowedRoleIds : base.allowedRoleIds || [],
    mutedRoleIds: Array.isArray(dto.mutedRoleIds) ? dto.mutedRoleIds : base.mutedRoleIds || [],
    restartNonce: dto.restartNonce ?? base.restartNonce,
    enableTranslation: dto.enableTranslation === true,
    translationProvider: dto.translationProvider || base.translationProvider || "deepseek",
    translationApiKey:
      typeof resolveSecretValue(dto.translationApiKey, base.translationApiKey) === "string" &&
      resolveSecretValue(dto.translationApiKey, base.translationApiKey)!.trim()
        ? resolveSecretValue(dto.translationApiKey, base.translationApiKey)!.trim()
        : typeof resolveSecretValue(dto.deepseekApiKey, base.deepseekApiKey) === "string" &&
            resolveSecretValue(dto.deepseekApiKey, base.deepseekApiKey)!.trim()
          ? resolveSecretValue(dto.deepseekApiKey, base.deepseekApiKey)!.trim()
          : base.translationApiKey,
    translationSecret:
      typeof resolveSecretValue(dto.translationSecret, base.translationSecret) === "string" &&
      resolveSecretValue(dto.translationSecret, base.translationSecret)!.trim()
        ? resolveSecretValue(dto.translationSecret, base.translationSecret)!.trim()
        : base.translationSecret,
    translationBaseUrl:
      typeof dto.translationBaseUrl === "string" && dto.translationBaseUrl.trim()
        ? dto.translationBaseUrl.trim()
        : base.translationBaseUrl,
    translationModel:
      typeof dto.translationModel === "string" && dto.translationModel.trim()
        ? dto.translationModel.trim()
        : base.translationModel,
    translationPrompt:
      typeof dto.translationPrompt === "string" && dto.translationPrompt.trim()
        ? dto.translationPrompt.trim()
        : base.translationPrompt,
    deepseekApiKey:
      typeof resolveSecretValue(dto.deepseekApiKey, base.deepseekApiKey) === "string" &&
      resolveSecretValue(dto.deepseekApiKey, base.deepseekApiKey)!.trim()
        ? resolveSecretValue(dto.deepseekApiKey, base.deepseekApiKey)!.trim()
        : undefined,
    enableBotRelay: dto.enableBotRelay === true,
    botRelays: nextBotRelays,
    channelRelayMap:
      dto.channelRelayMap && typeof dto.channelRelayMap === "object"
        ? dto.channelRelayMap
        : base.channelRelayMap || {},
    ignoreSelf: dto.ignoreSelf === true,
    ignoreBot: dto.ignoreBot === true,
    onlyBot: dto.onlyBot === true,
    ignoreImages: dto.ignoreImages === true,
    ignoreAudio: dto.ignoreAudio === true,
    ignoreVideo: dto.ignoreVideo === true,
    ignoreDocuments: dto.ignoreDocuments === true,
    ignoreEnglish: dto.ignoreEnglish === true,
    ignoreEnglishThreshold:
      typeof dto.ignoreEnglishThreshold === "number"
        ? dto.ignoreEnglishThreshold
        : base.ignoreEnglishThreshold,
    ignoreChinese: dto.ignoreChinese === true,
    ignoreChineseThreshold:
      typeof dto.ignoreChineseThreshold === "number"
        ? dto.ignoreChineseThreshold
        : base.ignoreChineseThreshold,
    stripEnglish: dto.stripEnglish === true,
    stripChinese: dto.stripChinese === true,
    dedupeSequentialMessages: dto.dedupeSequentialMessages === true,
    watermark: dto.watermark && typeof dto.watermark === "object" ? dto.watermark : base.watermark,
    watermarkSecondary:
      dto.watermarkSecondary && typeof dto.watermarkSecondary === "object"
        ? dto.watermarkSecondary
        : base.watermarkSecondary,
    watermarks: resolvedAccountWatermarks ?? base.watermarks,
    watermarkEnabled: dto.watermarkEnabled === false ? false : true,
    watermarkRemoval: shouldPersistWatermarkRemovalConfig(resolvedAccountWatermarkRemoval)
      ? {
          enabled:
            resolvedAccountWatermarkRemoval.enabled === false
              ? false
              : resolvedAccountWatermarkRemoval.enabled === true
                ? true
                : undefined,
          mode:
            resolvedAccountWatermarkRemoval.mode === "ocr"
              ? "ocr"
              : resolvedAccountWatermarkRemoval.mode === "always"
                ? "always"
                : undefined,
          apiKey: resolvedAccountWatermarkRemoval.apiKey,
          triggerKeywords: Array.isArray(resolvedAccountWatermarkRemoval.triggerKeywords)
            ? resolvedAccountWatermarkRemoval.triggerKeywords
            : undefined,
          provider:
            resolvedAccountWatermarkRemoval.provider === "iopaint"
              ? "iopaint"
              : resolvedAccountWatermarkRemoval.provider === "wavespeed"
                ? "wavespeed"
                : undefined,
          iopaintModel:
            resolvedAccountWatermarkRemoval.provider === "iopaint"
              ? resolvedAccountWatermarkRemoval.iopaintModel || "lama"
              : undefined,
          iopaintStrategy:
            resolvedAccountWatermarkRemoval.provider === "iopaint"
              ? resolvedAccountWatermarkRemoval.iopaintStrategy || "crop"
              : undefined,
          iopaintMaskMode:
            resolvedAccountWatermarkRemoval.provider === "iopaint"
              ? resolvedAccountWatermarkRemoval.iopaintMaskMode || "protect-text"
              : undefined,
          iopaintMaskPadding:
            resolvedAccountWatermarkRemoval.provider === "iopaint"
              ? resolvedAccountWatermarkRemoval.iopaintMaskPadding
              : undefined,
        }
      : undefined,
    watermarkCover: resolvedAccountWatermarkCover,
    scheduledContents: resolvedScheduledContents ?? base.scheduledContents,
    scheduledBroadcast: resolvedScheduledBroadcast ?? base.scheduledBroadcast,
    ocrServerUrl: typeof dto.ocrServerUrl === "string" && dto.ocrServerUrl.trim() ? dto.ocrServerUrl.trim() : "http://localhost:9003",
    ocrBlockedKeywords: Array.isArray(dto.ocrBlockedKeywords) ? dto.ocrBlockedKeywords : [],
    ocrTriggerKeywords: Array.isArray(dto.ocrTriggerKeywords) ? dto.ocrTriggerKeywords : [],
    feishuStyle:
      dto.feishuStyle === "style1" || dto.feishuStyle === "style2" || dto.feishuStyle === "style3"
        ? dto.feishuStyle
        : (base.feishuStyle || "style1"),
    // Telegram认证配置保存
    telegramBotToken:
      typeof resolveSecretValue(dto.telegramBotToken, base.telegramBotToken) === "string" &&
      resolveSecretValue(dto.telegramBotToken, base.telegramBotToken)!.trim()
        ? resolveSecretValue(dto.telegramBotToken, base.telegramBotToken)!.trim()
        : base.telegramBotToken,
    telegramApiId:
      typeof dto.telegramApiId === "number"
        ? dto.telegramApiId
        : typeof dto.telegramApiId === "string" && dto.telegramApiId.trim() && !isNaN(Number(dto.telegramApiId))
          ? Number(dto.telegramApiId)
          : undefined,
    telegramApiHash:
      typeof resolveSecretValue(dto.telegramApiHash, base.telegramApiHash) === "string" &&
      resolveSecretValue(dto.telegramApiHash, base.telegramApiHash)!.trim()
        ? resolveSecretValue(dto.telegramApiHash, base.telegramApiHash)!.trim()
        : base.telegramApiHash,
    telegramSessionPath: typeof dto.telegramSessionPath === "string" && dto.telegramSessionPath.trim() ? dto.telegramSessionPath.trim() : undefined,
    telegramSessionString:
      typeof resolveSecretValue(dto.telegramSessionString, base.telegramSessionString) === "string" &&
      resolveSecretValue(dto.telegramSessionString, base.telegramSessionString)!.trim()
        ? resolveSecretValue(dto.telegramSessionString, base.telegramSessionString)!.trim()
        : base.telegramSessionString,
    sessionType: dto.sessionType === "string" ? "string" : "file",
    // Telegram 超长消息处理配置
    enableTelegramOverflow: dto.enableTelegramOverflow === true,
    telegramOverflowThreshold: typeof dto.telegramOverflowThreshold === "number" && dto.telegramOverflowThreshold > 0 ? dto.telegramOverflowThreshold : 0,
    telegramOverflowMessage: typeof dto.telegramOverflowMessage === "string" && dto.telegramOverflowMessage.trim() ? dto.telegramOverflowMessage.trim() : "",
    // Telegram 配置（包含 accounts 和 mappings）
    telegramConfig: mergedTelegramConfig,
    discordLogin: mergedDiscordLogin,
    xConfig: mergedXConfig,
    truthSocialConfig: mergedTruthSocialConfig,
  };

  const mobileCategoryValidation = validateMobileClientCategoriesForStart(nextAccount);
  if (nextAccount.loginRequested === true && !mobileCategoryValidation.ok) {
    nextAccount.loginRequested = false;
    nextAccount.loginState = "error";
    nextAccount.loginMessage = "请先填写每条手机客户端规则的客户端分类";
  }

  return nextAccount;
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const includeSecrets =
      req.nextUrl.searchParams.get("includeSecrets") === "1" ||
      req.nextUrl.searchParams.get("export") === "1";
    const multi = alignDiscordLinkedAccountTypes(await getMultiConfig());
    const discordGuildsCache = await readJsonFileOr<Record<string, any>>(discordGuildsCacheFile, {});
    const discordChannelsCache = await readJsonFileOr<Record<string, any>>(discordChannelsCacheFile, {});
    const status = await readStatus();
    const discordLibraryStatus = await readDiscordLibraryStatus();
    const telegramStatus = await readTelegramStatus();
    const externalStatus = await readExternalForwardStatus();
    const forwardStats = await readForwardStats();
    const telegramLibrary = Array.isArray(multi.telegramAccounts) ? multi.telegramAccounts : [];
    const telegramLibraryById = new Map(telegramLibrary.map((acc) => [acc.id, acc]));
    const frontendTelegramAccounts: FrontendTelegramAccountLibrary[] = telegramLibrary.map((acc) => {
      const statusEntry = telegramStatus[acc.id];
      const normalizedState = normalizeTelegramState(statusEntry?.state);
      return {
        ...acc,
        loginState: normalizedState,
        loginMessage: normalizeTelegramMessage(normalizedState, statusEntry?.message),
        userInfo: statusEntry?.userInfo,
      };
    });
    const discordAccounts = Array.isArray(multi.discordAccounts) ? multi.discordAccounts : [];
    const frontendDiscordAccounts: FrontendDiscordAccountLibrary[] = discordAccounts.map((acc) => {
      const statusEntry = discordLibraryStatus[acc.id];
      const rawLoginState = typeof statusEntry?.loginState === "string" ? statusEntry.loginState : undefined;
      return {
        ...acc,
        loginState: rawLoginState ? normalizeDiscordState(rawLoginState) : undefined,
        loginMessage: typeof statusEntry?.loginMessage === "string" ? statusEntry.loginMessage : undefined,
      };
    });
    const xAccounts = Array.isArray(multi.xAccounts) ? multi.xAccounts : [];
    const truthSocialAccounts = Array.isArray(multi.truthSocialAccounts) ? multi.truthSocialAccounts : [];
    const payload: FrontendPayload = {
      accounts: multi.accounts.map((acc) => {
        const frontendBase = accountToFrontend(acc, {
          discordGuildsCache,
          discordChannelsCache,
          config: multi,
        });
        const runtimeStatus = status[acc.id] || {};
        const normalizedLoginState = normalizeDiscordState(
          typeof runtimeStatus.loginState === "string" ? runtimeStatus.loginState : frontendBase.loginState,
        );
        const { botStatus, clientStatus } = resolveTelegramAccountStatuses(acc, telegramStatus, telegramLibraryById);
        const botState = normalizeTelegramState(botStatus?.state);
        const clientState = normalizeTelegramState(clientStatus?.state);
        const frontend = {
          ...frontendBase,
          ...runtimeStatus,
          loginState: normalizedLoginState,
          telegramBotState: botState,
          telegramBotMessage: normalizeTelegramMessage(botState, botStatus?.message),
          telegramClientState: clientState,
          telegramClientMessage: normalizeTelegramMessage(clientState, clientStatus?.message),
          telegramAccountStates: buildTelegramAccountStates(acc, telegramStatus, telegramLibraryById),
          externalForwardStatus: {
            x: externalStatus?.x?.[acc.id],
            truthsocial: externalStatus?.truthsocial?.[acc.id],
          },
        };
        return includeSecrets ? frontend : maskFrontendAccount(frontend);
      }),
      discordAccounts: includeSecrets
        ? frontendDiscordAccounts
        : frontendDiscordAccounts.map((acc) => maskDiscordLibraryAccount(acc)),
      telegramAccounts: includeSecrets
        ? frontendTelegramAccounts
        : frontendTelegramAccounts.map((acc) => maskTelegramLibraryAccount(acc)),
      xAccounts: includeSecrets
        ? xAccounts
        : xAccounts.map((acc) => maskXLibraryAccount(acc as FrontendXAccountLibrary)),
      truthSocialAccounts: includeSecrets
        ? truthSocialAccounts
        : truthSocialAccounts.map((acc) => maskTruthLibraryAccount(acc as FrontendTruthSocialAccountLibrary)),
      activeId: multi.activeId || multi.accounts[0]?.id || "",
      loginUser: multi.loginUser || "",
      loginPassword: includeSecrets ? multi.loginPassword || "" : maskSecret(multi.loginPassword),
      telegramAvatarBaseUrl: multi.telegramAvatarBaseUrl || "",
      forwardStats,
      enabledForwardingTypes: multi.enabledForwardingTypes,
    };
    return NextResponse.json(payload);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const body = await req.json();
    let next: MultiConfig;

    if (Array.isArray(body?.accounts)) {
      const current = await getMultiConfig();
      const accounts = (body.accounts as FrontendAccount[]).map((acc) => {
        const currentAccount = current.accounts.find((a) => a.id === acc.id);
        return dtoToAccount(acc, currentAccount);
      });
      const activeId = typeof body.activeId === "string" ? body.activeId : accounts[0]?.id;
      const resolvedLoginPassword = resolveSecretValue(body.loginPassword, current.loginPassword);
      const currentDiscord = new Map((current.discordAccounts || []).map((acc) => [acc.id, acc]));
      const currentTelegram = new Map((current.telegramAccounts || []).map((acc) => [acc.id, acc]));
      const currentX = new Map((current.xAccounts || []).map((acc) => [acc.id, acc]));
      const currentTruth = new Map((current.truthSocialAccounts || []).map((acc) => [acc.id, acc]));

      const hasIncomingDiscordAccountLibrary = Array.isArray(body.discordAccounts);
      const shouldPreserveDiscordAccounts =
        hasIncomingDiscordAccountLibrary &&
        body.discordAccounts.length === 0 &&
        (current.discordAccounts || []).length > 0;

      const discordAccounts = shouldPreserveDiscordAccounts
        ? current.discordAccounts || []
        : hasIncomingDiscordAccountLibrary
        ? (body.discordAccounts as FrontendDiscordAccountLibrary[]).map((acc) =>
            dtoToDiscordLibraryAccount(acc, currentDiscord.get(acc.id)),
          )
        : current.discordAccounts || [];
      const telegramAccounts = Array.isArray(body.telegramAccounts)
        ? (body.telegramAccounts as FrontendTelegramAccountLibrary[]).map((acc) =>
            dtoToTelegramLibraryAccount(acc, currentTelegram.get(acc.id)),
          )
        : current.telegramAccounts || [];
      const xAccounts = Array.isArray(body.xAccounts)
        ? (body.xAccounts as FrontendXAccountLibrary[]).map((acc) =>
            dtoToXLibraryAccount(acc, currentX.get(acc.id)),
          )
        : current.xAccounts || [];
      const truthSocialAccounts = Array.isArray(body.truthSocialAccounts)
        ? (body.truthSocialAccounts as FrontendTruthSocialAccountLibrary[]).map((acc) =>
            dtoToTruthLibraryAccount(acc, currentTruth.get(acc.id)),
          )
        : current.truthSocialAccounts || [];

      next = alignDiscordLinkedAccountTypes({
        accounts,
        activeId,
        loginUser: typeof body.loginUser === "string" ? body.loginUser : current.loginUser,
        loginPassword: typeof resolvedLoginPassword === "string" ? resolvedLoginPassword : current.loginPassword,
        telegramAvatarBaseUrl:
          typeof body.telegramAvatarBaseUrl === "string" && body.telegramAvatarBaseUrl.trim()
            ? body.telegramAvatarBaseUrl.trim()
            : current.telegramAvatarBaseUrl,
        discordAccounts,
        telegramAccounts,
        xAccounts,
        truthSocialAccounts,
      });
    } else {
      // 兼容旧版请求
      const id = randomUUID();
      const channelWebhooks: Record<string, string> = {};
      if (Array.isArray(body?.mappings)) {
        for (const m of body.mappings) {
          if (m?.sourceChannelId && m?.targetWebhookUrl) {
            channelWebhooks[String(m.sourceChannelId)] = String(m.targetWebhookUrl);
          }
        }
      }
      const replacements: Record<string, string> = {};
      if (Array.isArray(body?.replacements)) {
        for (const r of body.replacements) {
          if (r?.from) replacements[String(r.from)] = String(r.to ?? "");
        }
      }
      const account: AccountConfig = {
        id,
        name: "默认账号",
        type: "selfbot",
        token: body?.discordToken || "",
        proxyUrl: body?.proxyUrl || "",
        loginRequested: false,
        channelWebhooks,
        channelNotes: {},
        blockedKeywords: Array.isArray(body?.blockedKeywords) ? body.blockedKeywords : [],
        excludeKeywords: Array.isArray(body?.excludeKeywords) ? body.excludeKeywords : [],
        replacementsDictionary: replacements,
        showSourceIdentity: body?.showSourceIdentity === true,
        historyScan: { enabled: true },
      };
      next = alignDiscordLinkedAccountTypes({ accounts: [account], activeId: id });
    }

    await saveMultiConfig(next);
    try {
      await fs.mkdir(path.dirname(triggerFile), { recursive: true });
      await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
    } catch {}
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const body = await req.json();

    // 验证配置格式
    if (!body?.accounts || !Array.isArray(body.accounts)) {
      return NextResponse.json({ error: "配置格式错误：缺少 accounts 数组" }, { status: 400 });
    }

    const current = await getMultiConfig();
    // 转换前端格式到后端格式
    const accounts = (body.accounts as FrontendAccount[]).map((acc) => {
      const currentAccount = current.accounts.find((a) => a.id === acc.id);
      return dtoToAccount(acc, currentAccount);
    });

    const activeId = typeof body.activeId === "string" ? body.activeId : accounts[0]?.id;
    const resolvedLoginPassword = resolveSecretValue(body.loginPassword, current.loginPassword);

    const next = alignDiscordLinkedAccountTypes({
      accounts,
      activeId,
      loginUser: typeof body.loginUser === "string" ? body.loginUser : current.loginUser,
      loginPassword: typeof resolvedLoginPassword === "string" ? resolvedLoginPassword : current.loginPassword,
      telegramAvatarBaseUrl:
        typeof body.telegramAvatarBaseUrl === "string" && body.telegramAvatarBaseUrl.trim()
          ? body.telegramAvatarBaseUrl.trim()
          : current.telegramAvatarBaseUrl,
      discordAccounts: current.discordAccounts,
      telegramAccounts: current.telegramAccounts,
      xAccounts: current.xAccounts,
      truthSocialAccounts: current.truthSocialAccounts,
    });

    await saveMultiConfig(next);

    // 触发配置重载
    try {
      await fs.mkdir(path.dirname(triggerFile), { recursive: true });
      await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
    } catch {}

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
