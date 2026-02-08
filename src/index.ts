import { Client as BotClient, GatewayIntentBits, Partials } from "discord.js";
import { Client as SelfBotClient } from "discord.js-selfbot-v13";
import { promises as fs } from "fs";
import { watch, stat } from "node:fs";
import path from "node:path";
import { createHash } from "crypto";

import { Bot, Client } from "./bot.js";
import { OCRClient } from "./ocrClient.js";
import {
  getMultiConfig,
  saveMultiConfig,
  type MultiConfig,
  type AccountConfig,
  type DiscordAccountLibrary,
  type RuleLevelConfig,
  type ScheduledContentItem,
  accountToLegacyConfig,
  ensureConfigFile,
  getConfigPath,
  resolveMultiConfigForRuntime,
} from "./config.js";
import { getEnv } from "./env.js";
import { SenderBot } from "./senderBot.js";
import { FeishuSender } from "./feishuSender.js";
import { ProxyAgent } from "proxy-agent";
import { FileLogger } from "./logger.js";
import { telegramBridgeManager, discordBridgeManager } from "./processManager.js";
import { TelegramBridgeClient, type SendMessageParams } from "./telegramBridgeClient.js";
import { DiscordBridgeClient, type DiscordBridgeAccountConfig } from "./discordBridgeClient.js";
import { formatKeywordGroups, matchParsedKeywordGroups, parseKeywordGroups } from "./keywordMatcher.js";
import { clampPercent, getLanguageRatio, stripLanguages } from "./languageFilter.js";
import { preloadWatermarkFonts, resolveWatermarkList } from "./watermark.js";
import { reconcileExternalForwarders, shutdownExternalForwarders } from "./externalForwarder.js";
import { recordForwardStat } from "./forwardStats.js";
import { stripEmbedText, stripEmbedTitles } from "./embedUtils.js";

// 全局 Telegram Bridge 客户端
let telegramBridgeClient: TelegramBridgeClient | null = null;
// 全局 Discord Bridge 客户端
let discordBridgeClient: DiscordBridgeClient | null = null;
const telegramSequentialDedupe = new Map<string, string>();
const telegramStandbyActivity = new Map<string, number>();
const telegramStandbyPending = new Map<string, NodeJS.Timeout>();
let telegramStandbyPendingSeq = 0;

interface RunningAccount {
  account: AccountConfig;
  client: Client;
  bot: Bot;
  senderBotsBySource: Map<string, SenderBot[]>;  // 支持相同源ID对应多个webhook
  defaultSenderBot?: SenderBot; // 如果关闭 Discord 转发，可能为 undefined
  feishuSendersBySource?: Map<string, any>;
  isManuallyStopped: boolean; // 标记是否手动停止
  reconnectTimer?: NodeJS.Timeout; // 重连定时器
  reconnectCount: number; // 重连次数
  lastReconnectTime: number; // 上次重连时间
  isLoggingIn?: boolean; // 是否正在登录中，用于防止重复登录
  loginTimeout?: NodeJS.Timeout; // 登录超时定时器
  sharedKey?: string;
  sharedPrimary?: boolean;
  scheduledJobs?: Map<string, NodeJS.Timeout>;
  scheduledSenderCache?: Map<string, SenderBot>;
  scheduledInFlight?: Set<string>;
}

type ScheduledTarget =
  | {
      key: string;
      kind: "discord";
      webhookUrl: string;
      mappingType: string;
      label: string;
      rule?: RuleLevelConfig;
    }
  | {
      key: string;
      kind: "telegram";
      chatId: string;
      mappingType: string;
      label: string;
      preferredSenderType?: "bot" | "client";
      rule?: RuleLevelConfig;
    }
  | {
      key: string;
      kind: "feishu";
      target: string;
      mode: "webhook" | "thread";
      mappingType: string;
      label: string;
      rule?: RuleLevelConfig;
    };

const runningAccounts = new Map<string, RunningAccount>();
const sharedDiscordClients = new Map<
  string,
  { key: string; token: string; type: "bot" | "selfbot"; client: Client; accountIds: Set<string> }
>();
let currentConfig: MultiConfig | null = null;
const statusFile = path.resolve(process.cwd(), ".data", "status.json");
const discordLibraryStatusFile = path.resolve(process.cwd(), ".data", "discord_library_status.json");
const telegramLoginRequestFile = path.resolve(process.cwd(), ".data", "telegram_login_request.json");
const telegramLoginResponseFile = path.resolve(process.cwd(), ".data", "telegram_login_response.json");
const telegramSyncRequestDir = path.resolve(process.cwd(), ".data", "telegram_sync_requests");
const telegramSyncResponseDir = path.resolve(process.cwd(), ".data", "telegram_sync_responses");
const discordLoginRequestFile = path.resolve(process.cwd(), ".data", "discord_login_request.json");
const discordLoginResponseFile = path.resolve(process.cwd(), ".data", "discord_login_response.json");
const discordGuildsCacheFile = path.resolve(process.cwd(), ".data", "discord_guilds_cache.json");
const discordChannelsCacheFile = path.resolve(process.cwd(), ".data", "discord_channels_cache.json");
const telegramDialogsCacheFile = path.resolve(process.cwd(), ".data", "telegram_dialogs_cache.json");
const ocrClients = new Map<string, { url: string; client: OCRClient }>();
const translationSenders = new Map<string, { key: string; sender: SenderBot }>();
const telegramReplyMap = new Map<string, string>();
const telegramReplyQueue: string[] = [];
const TELEGRAM_REPLY_CACHE_LIMIT = 10000;
const EXTERNAL_FORWARDING_TYPES = new Set(["x-to-discord", "truthsocial-to-discord"]);
// 记录已经输出过"未配置 token"错误的账号，避免重复日志
const loggedNoTokenAccounts = new Set<string>();
// 记录配置文件的 hash，只在真正变化时才重新读取
let lastConfigHash: string | null = null;
let lastConfigMtime: number = 0;
let telegramLoginProcessing = false;
let lastTelegramWatchSummaryHash: string | null = null;
let lastTelegramConfigPayloadHash: string | null = null;
let telegramSyncProcessing = false;
let discordLoginProcessing = false;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isExternalForwardingType(type?: string): boolean {
  return typeof type === "string" && EXTERNAL_FORWARDING_TYPES.has(type);
}

function buildTelegramReplyKey(sourceChatId: string, sourceMessageId: string, targetChatId: string): string {
  return `${sourceChatId}:${sourceMessageId}:${targetChatId}`;
}

function recordTelegramReplyMapping(
  sourceChatId: string,
  sourceMessageId: string,
  targetChatId: string,
  targetMessageId: string,
) {
  const key = buildTelegramReplyKey(sourceChatId, sourceMessageId, targetChatId);
  if (telegramReplyMap.has(key)) return;
  telegramReplyMap.set(key, targetMessageId);
  telegramReplyQueue.push(key);
  if (telegramReplyQueue.length > TELEGRAM_REPLY_CACHE_LIMIT) {
    const oldest = telegramReplyQueue.shift();
    if (oldest) {
      telegramReplyMap.delete(oldest);
    }
  }
}

function resolveTelegramReplyTarget(
  sourceChatId?: string,
  replyToMessageId?: string | number,
  targetChatId?: string,
): string | undefined {
  if (!sourceChatId || !replyToMessageId || !targetChatId) return undefined;
  return telegramReplyMap.get(buildTelegramReplyKey(String(sourceChatId), String(replyToMessageId), String(targetChatId)));
}

function getPublicBaseUrl(override?: string): string | null {
  const base =
    currentConfig?.telegramAvatarBaseUrl ||
    override ||
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    "";
  return base ? base.replace(/\/$/, "") : null;
}

function buildTelegramCdnAvatarUrl(username?: string): string | undefined {
  if (!username) return undefined;
  const cleaned = username.startsWith("@") ? username.slice(1) : username;
  if (!cleaned) return undefined;
  return `https://t.me/i/userpic/320/${encodeURIComponent(cleaned)}.jpg`;
}

function buildTelegramAvatarUrl(
  avatarFile?: string,
  avatarUrl?: string,
  baseOverride?: string,
  username?: string,
): string | undefined {
  if (avatarUrl) return avatarUrl;
  const cdnUrl = buildTelegramCdnAvatarUrl(username);
  const base = getPublicBaseUrl(baseOverride);
  if (base && avatarFile) {
    return `${base}/api/telegram/avatar/${encodeURIComponent(avatarFile)}`;
  }
  return cdnUrl;
}

function getOcrClient(account: AccountConfig): OCRClient | null {
  const serverUrl = account.ocrServerUrl;
  if (!serverUrl) return null;
  const cached = ocrClients.get(account.id);
  if (cached && cached.url === serverUrl) {
    return cached.client;
  }
  const client = new OCRClient(serverUrl, undefined);
  ocrClients.set(account.id, { url: serverUrl, client });
  return client;
}

function getTranslationSender(account: AccountConfig): SenderBot | null {
  if (account.enableTranslation !== true) return null;
  const provider = account.translationProvider || "deepseek";
  const apiKey = account.translationApiKey || account.deepseekApiKey;
  if (!apiKey) return null;
  const proxy = account.proxyUrl || getEnv().PROXY_URL;
  const cacheKey = `${provider}|${apiKey}|${account.translationSecret || ""}|${proxy || ""}`;
  const cached = translationSenders.get(account.id);
  if (cached && cached.key === cacheKey) {
    return cached.sender;
  }
  const httpAgent = proxy ? new ProxyAgent(proxy as any) : undefined;
  const sender = new SenderBot({
    webhookUrl: "http://localhost",
    enableTranslation: true,
    translationProvider: provider as any,
    translationApiKey: apiKey,
    translationSecret: account.translationSecret,
    deepseekApiKey: account.deepseekApiKey,
    httpAgent,
  });
  translationSenders.set(account.id, { key: cacheKey, sender });
  return sender;
}

function formatTimestampFromSeconds(seconds?: number): string {
  const now = seconds ? new Date(seconds * 1000) : new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function formatLogPreview(text?: string, limit = 160): string {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "(无文本内容)";
  return normalized.length > limit ? normalized.slice(0, limit) + "..." : normalized;
}

function buildTelegramSequentialSignature(params: any, content: string, mediaItems: any[]): string {
  const normalized = (content || "").replace(/\s+/g, " ").trim();
  const mediaTags: string[] = [];
  if (params?.photo) mediaTags.push(`photo:${String(params.photo)}`);
  if (params?.video) mediaTags.push(`video:${String(params.video)}`);
  if (params?.document) mediaTags.push(`document:${String(params.document)}`);
  for (const item of mediaItems || []) {
    if (!item) continue;
    const type = item.type || item.mimeType || "media";
    const fingerprint =
      item.fileId ||
      item.file_id ||
      item.url ||
      item.localPath ||
      item.fileName ||
      item.filename ||
      "";
    mediaTags.push(`${String(type)}:${String(fingerprint)}`);
  }
  const mediaSignature = mediaTags.join("|");
  return `${normalized}||media:${mediaSignature}`;
}

function normalizeTelegramChatId(value: string | number): string | number {
  if (typeof value === "number") return value;
  const trimmed = String(value || "").trim();
  if (!trimmed) return value;
  if (/^-?\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num)) return num;
  }
  return trimmed;
}

function buildTelegramChatIdVariants(value?: string | number): Set<string> {
  const variants = new Set<string>();
  if (value === undefined || value === null) return variants;
  const raw = String(value).trim();
  if (!raw) return variants;
  variants.add(raw);
  if (!/^-?\d+$/.test(raw)) return variants;
  const unsigned = raw.startsWith("-") ? raw.slice(1) : raw;
  if (unsigned) variants.add(unsigned);
  const without100 = unsigned.startsWith("100") && unsigned.length > 3 ? unsigned.slice(3) : "";
  if (without100) variants.add(without100);
  variants.add(`-${unsigned}`);
  if (unsigned && !unsigned.startsWith("100")) {
    variants.add(`-100${unsigned}`);
    variants.add(`100${unsigned}`);
  } else if (without100) {
    variants.add(`-100${without100}`);
    variants.add(`100${without100}`);
  }
  return variants;
}

function isTelegramSourceMatch(
  raw: string,
  sourceChatId?: string,
  sourceChatUsername?: string,
): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (sourceChatUsername) {
    const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (normalized === sourceChatUsername) return true;
  }
  if (!sourceChatId) return false;
  const rawVariants = buildTelegramChatIdVariants(trimmed);
  const sourceVariants = buildTelegramChatIdVariants(sourceChatId);
  for (const candidate of rawVariants) {
    if (sourceVariants.has(candidate)) return true;
  }
  return false;
}

function isTelegramIdentifierMatch(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const rawA = String(a).trim();
  const rawB = String(b).trim();
  if (!rawA || !rawB) return false;
  const normA = rawA.startsWith("@") ? rawA.slice(1).toLowerCase() : rawA.toLowerCase();
  const normB = rawB.startsWith("@") ? rawB.slice(1).toLowerCase() : rawB.toLowerCase();
  if (normA === normB) return true;
  const variantsA = buildTelegramChatIdVariants(rawA);
  const variantsB = buildTelegramChatIdVariants(rawB);
  for (const candidate of variantsA) {
    if (variantsB.has(candidate)) return true;
  }
  return false;
}

function applyLongMessageConfig(
  content: string,
  config?: { enabled?: boolean; threshold?: number; appendMessage?: string },
): string {
  if (!config?.enabled) return content;
  const threshold = typeof config.threshold === "number" ? config.threshold : 0;
  if (threshold > 0 && content.length > threshold) {
    const trimmed = content.slice(0, threshold);
    const append = typeof config.appendMessage === "string" ? config.appendMessage.trim() : "";
    return append ? `${trimmed}\n${append}` : trimmed;
  }
  return content;
}

type TelegramAccountRef = {
  id: string;
  type: "bot" | "client";
  role?: "listener" | "sender";
  enabled?: boolean;
};

function collectTelegramAccounts(account: AccountConfig): TelegramAccountRef[] {
  const results: TelegramAccountRef[] = [];
  const seen = new Set<string>();
  const push = (entry: TelegramAccountRef) => {
    if (!entry.id || seen.has(entry.id)) return;
    results.push(entry);
    seen.add(entry.id);
  };

  const configured = account.telegramConfig?.accounts || [];
  for (const item of configured) {
    if (!item?.id) continue;
    const type = item.type === "bot" ? "bot" : "client";
    const role = item.role === "listener" || item.role === "sender" ? item.role : undefined;
    push({ id: item.id, type, role, enabled: item.enabled !== false });
  }

  const hasLegacyClient = Boolean(
    (account.telegramSessionPath || account.telegramSessionString) &&
      account.telegramApiId &&
      account.telegramApiHash,
  );
  const hasLegacyBot = Boolean(account.telegramBotToken);

  if (hasLegacyClient) {
    push({ id: account.id, type: "client", enabled: true });
  }
  if (hasLegacyBot) {
    push({ id: `${account.id}_bot`, type: "bot", enabled: true });
  }

  return results;
}

function collectTelegramAccountIds(account: AccountConfig): Set<string> {
  const ids = new Set<string>();
  for (const entry of collectTelegramAccounts(account)) {
    if (entry.id) ids.add(entry.id);
  }
  return ids;
}

function collectTelegramAccountTypeMap(account: AccountConfig): Map<string, "bot" | "client"> {
  const result = new Map<string, "bot" | "client">();
  for (const entry of collectTelegramAccounts(account)) {
    if (entry.id) {
      result.set(entry.id, entry.type);
    }
  }
  return result;
}

function collectTelegramAccountRoleMap(account: AccountConfig): Map<string, "listener" | "sender"> {
  const result = new Map<string, "listener" | "sender">();
  for (const entry of collectTelegramAccounts(account)) {
    if (entry.id && (entry.role === "listener" || entry.role === "sender")) {
      result.set(entry.id, entry.role);
    }
  }
  return result;
}

function hasTelegramRoleAccount(account: AccountConfig, role: "listener" | "sender"): boolean {
  return collectTelegramAccounts(account).some((entry) => entry.role === role);
}

function selectTelegramSendAccount(
  account: AccountConfig,
  preferredType?: "bot" | "client",
  preferredRole?: "listener" | "sender",
): TelegramAccountRef | null {
  const candidates = collectTelegramAccounts(account).filter((entry) => entry.enabled !== false);
  if (candidates.length === 0) return null;
  if (preferredRole) {
    const roleMatches = candidates.filter((entry) => entry.role === preferredRole);
    if (roleMatches.length > 0) {
      if (preferredType) {
        const match = roleMatches.find((entry) => entry.type === preferredType);
        if (match) return match;
      }
      return roleMatches[0];
    }
  }
  if (preferredType) {
    const match = candidates.find((entry) => entry.type === preferredType);
    if (match) return match;
  }
  if (candidates.length === 1) return candidates[0];
  const bot = candidates.find((entry) => entry.type === "bot");
  return bot || candidates[0];
}

function selectTelegramAccountByType(
  account: AccountConfig,
  type: "bot" | "client",
): TelegramAccountRef | null {
  const candidates = collectTelegramAccounts(account).filter((entry) => entry.enabled !== false);
  const match = candidates.find((entry) => entry.type === type);
  return match || null;
}

function shouldFallbackToTelegramClient(sendResult: any): boolean {
  if (!sendResult) return false;
  const errorText = `${sendResult.error || ""} ${sendResult.message || ""}`.toLowerCase();
  if (!errorText) return false;
  if (errorText.includes("chat not found")) return true;
  if (errorText.includes("bot was kicked")) return true;
  if (errorText.includes("forbidden")) return true;
  if (errorText.includes("not enough rights")) return true;
  return false;
}

function normalizeTelegramStandbyKey(value?: string): string {
  if (!value) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  return raw.startsWith("@") ? raw.slice(1).toLowerCase() : raw;
}

function buildTelegramStandbyKeys(value?: string): string[] {
  if (!value) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  const keys = new Set<string>();
  const normalized = normalizeTelegramStandbyKey(raw);
  if (normalized) keys.add(normalized);
  if (/^-?\d+$/.test(raw)) {
    for (const variant of buildTelegramChatIdVariants(raw)) {
      if (variant) keys.add(variant);
    }
  }
  return [...keys];
}

function recordTelegramStandbyActivity(chatId?: string, username?: string) {
  const now = Date.now();
  for (const key of buildTelegramStandbyKeys(chatId)) {
    telegramStandbyActivity.set(key, now);
  }
  for (const key of buildTelegramStandbyKeys(username)) {
    telegramStandbyActivity.set(key, now);
  }
}

function getTelegramStandbyLastActive(mainChannelId?: string): number {
  let last = 0;
  for (const key of buildTelegramStandbyKeys(mainChannelId)) {
    last = Math.max(last, telegramStandbyActivity.get(key) || 0);
  }
  return last;
}

function isTelegramStandbyMainChannel(
  mainChannelId: string | undefined,
  sourceChatId?: string,
  sourceChatUsername?: string,
): boolean {
  if (!mainChannelId) return false;
  return isTelegramSourceMatch(mainChannelId, sourceChatId, sourceChatUsername);
}

async function sendTelegramMessageWithFallback(
  bridge: TelegramBridgeClient,
  account: AccountConfig,
  preferredType: "bot" | "client" | undefined,
  preferredRole: "listener" | "sender" | undefined,
  params: Omit<SendMessageParams, "accountId" | "accountType">,
  log?: (message: string) => void,
): Promise<{ result: any; account: TelegramAccountRef | null; usedFallback: boolean }> {
  const primary = selectTelegramSendAccount(account, preferredType, preferredRole);
  if (!primary) {
    return { result: null, account: null, usedFallback: false };
  }

  const sendWithAccount = async (entry: TelegramAccountRef) => {
    return bridge.sendMessage({
      accountId: entry.id,
      accountType: entry.type,
      chatId: params.chatId,
      message: params.message,
      media: params.media,
    });
  };

  let result = await sendWithAccount(primary);
  if (
    primary.type === "bot" &&
    shouldFallbackToTelegramClient(result)
  ) {
    let fallback = selectTelegramSendAccount(account, "client", preferredRole);
    // 如果没有配置 sender 角色账号，允许回退到任意 client（包括 listener）
    if (!fallback && preferredRole && !hasTelegramRoleAccount(account, preferredRole)) {
      fallback = selectTelegramAccountByType(account, "client");
    }
    if (fallback && fallback.id !== primary.id) {
      log?.(`[TG] Bot 发送失败，尝试使用 Client 账号重试（${fallback.id}）`);
      result = await sendWithAccount(fallback);
      return { result, account: fallback, usedFallback: true };
    }
  }

  return { result, account: primary, usedFallback: false };
}

function parseFeishuTarget(raw: any): { mode: "webhook" | "thread"; target: string } | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return { mode: "webhook", target: trimmed };
  }
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode === "thread" ? "thread" : "webhook";
  if (mode === "thread") {
    const threadId = typeof raw.threadId === "string" ? raw.threadId.trim() : "";
    if (!threadId) return null;
    return { mode, target: threadId };
  }
  const webhookUrl = typeof raw.webhookUrl === "string" ? raw.webhookUrl.trim() : "";
  if (!webhookUrl) return null;
  return { mode, target: webhookUrl };
}

function resolveScheduledConfig(
  account: AccountConfig,
  rule?: RuleLevelConfig,
): { intervalMinutes: number; contentIds: string[] } | null {
  const globalConfig = account.scheduledBroadcast;
  const ruleConfig = rule?.scheduledBroadcast;
  if (ruleConfig?.enabled === false) return null;
  const ruleEnabled = ruleConfig?.enabled === true;
  const globalEnabled = globalConfig?.enabled === true;
  if (!ruleEnabled && !globalEnabled) return null;
  const intervalMinutes =
    (ruleEnabled ? ruleConfig?.intervalMinutes : undefined) ??
    (globalEnabled ? globalConfig?.intervalMinutes : undefined) ??
    60;
  const contentIds =
    (ruleEnabled ? ruleConfig?.contentIds : undefined) ??
    (globalEnabled ? globalConfig?.contentIds : undefined) ??
    [];
  const normalizedIds = Array.isArray(contentIds) ? contentIds.map(String).filter(Boolean) : [];
  if (normalizedIds.length === 0) return null;
  return {
    intervalMinutes: Math.max(1, Math.round(intervalMinutes || 60)),
    contentIds: normalizedIds,
  };
}

function resolveScheduledContents(
  account: AccountConfig,
  contentIds: string[],
): ScheduledContentItem[] {
  if (!Array.isArray(contentIds) || contentIds.length === 0) return [];
  const set = new Set(contentIds.map(String));
  const items = Array.isArray(account.scheduledContents) ? account.scheduledContents : [];
  return items.filter((item) => {
    if (!item || !item.id || !set.has(item.id)) return false;
    if (item.enabled === false) return false;
    const hasText = typeof item.text === "string" && item.text.trim().length > 0;
    const hasMedia = typeof item.mediaValue === "string" && item.mediaValue.trim().length > 0;
    return hasText || hasMedia;
  });
}

function inferMediaSource(value?: string, source?: "local" | "url"): "local" | "url" | undefined {
  if (source === "local" || source === "url") return source;
  if (!value) return undefined;
  return /^https?:\/\//i.test(value) ? "url" : "local";
}

function buildScheduledUploads(item: ScheduledContentItem): Array<{ url?: string; localPath?: string; filename: string; isImage?: boolean; isVideo?: boolean }> {
  const uploads: Array<{ url?: string; localPath?: string; filename: string; isImage?: boolean; isVideo?: boolean }> = [];
  const rawValue = typeof item.mediaValue === "string" ? item.mediaValue.trim() : "";
  if (!rawValue) return uploads;
  const mediaSource = inferMediaSource(rawValue, item.mediaSource);
  if (!mediaSource) return uploads;
  const filename = path.basename(rawValue.split("?")[0]) || "media";
  const isImage = item.mediaType === "image";
  const isVideo = item.mediaType === "video";
  if (mediaSource === "url") {
    uploads.push({ url: rawValue, filename, isImage, isVideo });
  } else {
    uploads.push({ localPath: rawValue, filename, isImage, isVideo });
  }
  return uploads;
}

function formatScheduledItemLabel(item: ScheduledContentItem): string {
  if (item.name && item.name.trim()) return item.name.trim();
  if (item.text && item.text.trim()) return item.text.trim().slice(0, 24);
  if (item.mediaValue) return path.basename(item.mediaValue);
  return item.id;
}

function collectScheduledTargets(account: AccountConfig): ScheduledTarget[] {
  const targets: ScheduledTarget[] = [];
  const forwardingType = account.forwardingType || "discord-to-discord";

  if (forwardingType === "discord-to-discord" && account.enableDiscordForward !== false) {
    const mappings = Array.isArray(account.mappings) ? account.mappings : [];
    for (const mapping of mappings) {
      if (!mapping?.id || !mapping?.targetWebhookUrl) continue;
      targets.push({
        key: `discord:${mapping.id}`,
        kind: "discord",
        webhookUrl: mapping.targetWebhookUrl,
        mappingType: "discord-to-discord",
        label: mapping.note || mapping.sourceChannelId || mapping.id,
        rule: mapping,
      });
    }
  }

  if (
    (forwardingType === "discord-to-telegram" ||
      forwardingType === "telegram-to-discord" ||
      forwardingType === "telegram-to-telegram") &&
    account.telegramConfig?.enableTelegramForward !== false
  ) {
    const mappings = Array.isArray(account.telegramConfig?.mappings) ? account.telegramConfig?.mappings : [];
    for (const mapping of mappings) {
      if (!mapping || mapping.type !== forwardingType) continue;
      const mappingId = mapping.id || `${mapping.sourceChannelId}_${mapping.targetChannelId}`;
      if (mapping.type === "telegram-to-discord") {
        if (!mapping.targetChannelId) continue;
        targets.push({
          key: `discord:${mappingId}`,
          kind: "discord",
          webhookUrl: mapping.targetChannelId,
          mappingType: mapping.type,
          label: mapping.note || mapping.sourceChannelId || mappingId,
          rule: mapping,
        });
      } else {
        if (!mapping.targetChannelId) continue;
        const preferredSenderType =
          mapping.type === "discord-to-telegram" && (mapping.senderAccountType === "bot" || mapping.senderAccountType === "client")
            ? mapping.senderAccountType
            : account.telegramConfig?.defaultSenderAccountType;
        targets.push({
          key: `telegram:${mappingId}`,
          kind: "telegram",
          chatId: mapping.targetChannelId,
          mappingType: mapping.type,
          label: mapping.note || mapping.sourceChannelId || mappingId,
          preferredSenderType: preferredSenderType === "bot" || preferredSenderType === "client" ? preferredSenderType : undefined,
          rule: mapping,
        });
      }
    }
  }

  if (forwardingType === "discord-to-feishu" && account.enableFeishuForward === true) {
    const feishuTargets = account.channelFeishuWebhooks || {};
    for (const [sourceId, rawTarget] of Object.entries(feishuTargets)) {
      const target = parseFeishuTarget(rawTarget);
      if (!target) continue;
      const rule = account.feishuRuleConfigs?.[sourceId];
      targets.push({
        key: `feishu:${sourceId}`,
        kind: "feishu",
        target: target.target,
        mode: target.mode,
        mappingType: "discord-to-feishu",
        label: sourceId,
        rule,
      });
    }
  }

  return targets;
}

function getScheduledSenderBot(
  running: RunningAccount,
  account: AccountConfig,
  webhookUrl: string,
): SenderBot {
  if (!running.scheduledSenderCache) {
    running.scheduledSenderCache = new Map();
  }
  const cached = running.scheduledSenderCache.get(webhookUrl);
  if (cached) return cached;
  const proxy = account.proxyUrl || getEnv().PROXY_URL;
  const httpAgent = proxy ? new ProxyAgent(proxy as unknown as any) : undefined;
  const sender = new SenderBot({
    replacementsDictionary: account.replacementsDictionary || {},
    webhookUrl,
    httpAgent,
    enableTranslation: false,
    watermark: account.watermark,
    watermarkSecondary: account.watermarkSecondary,
    watermarks: account.watermarks,
    watermarkEnabled: account.watermarkEnabled !== false,
  });
  running.scheduledSenderCache.set(webhookUrl, sender);
  return sender;
}

async function dispatchScheduledToDiscord(
  account: AccountConfig,
  running: RunningAccount,
  target: ScheduledTarget & { kind: "discord" },
  item: ScheduledContentItem,
) {
  const sender = getScheduledSenderBot(running, account, target.webhookUrl);
  const uploads = buildScheduledUploads(item);
  const content = typeof item.text === "string" ? item.text : "";
  await sender.sendData([
    {
      content,
      uploads: uploads.length > 0 ? uploads : undefined,
      ruleReplacementsDictionary: target.rule?.replacementsDictionary,
      watermark: target.rule?.watermark,
      watermarkSecondary: target.rule?.watermarkSecondary,
      watermarks: target.rule?.watermarks,
    },
  ]);
}

async function dispatchScheduledToTelegram(
  account: AccountConfig,
  target: ScheduledTarget & { kind: "telegram" },
  item: ScheduledContentItem,
) {
  const bridge = telegramBridgeClient;
  if (!bridge) {
    throw new Error("Telegram Bridge 未就绪");
  }
  const sendChatId = normalizeTelegramChatId(target.chatId);
  const uploads = buildScheduledUploads(item);
  let content = typeof item.text === "string" ? item.text : "";
  const replacements = account.replacementsDictionary || {};
  for (const [a, b] of Object.entries(replacements)) {
    content = content.replaceAll(a, b);
  }
  if (target.rule?.replacementsDictionary) {
    for (const [a, b] of Object.entries(target.rule.replacementsDictionary)) {
      content = content.replaceAll(a, b);
    }
  }
  const effectiveWatermarks = account.watermarkEnabled === false
    ? []
    : resolveWatermarkList(
        account.watermarks,
        target.rule?.watermarks,
        account.watermark,
        target.rule?.watermark,
        account.watermarkSecondary,
        target.rule?.watermarkSecondary,
      );
  const { account: senderAccount } = await sendTelegramMessageWithFallback(
    bridge,
    account,
    target.preferredSenderType,
    "sender",
    {
      chatId: sendChatId,
      message: {
        text: content,
        watermark: effectiveWatermarks[0],
        watermarkSecondary: effectiveWatermarks[1],
        watermarks: effectiveWatermarks,
      },
      media: uploads.length > 0 ? uploads : undefined,
    },
  );
  if (!senderAccount) {
    throw new Error("未找到可用 Telegram 发送账号");
  }
}

async function dispatchScheduledToFeishu(
  account: AccountConfig,
  running: RunningAccount,
  target: ScheduledTarget & { kind: "feishu" },
  item: ScheduledContentItem,
) {
  if (!running.feishuSendersBySource) {
    running.feishuSendersBySource = new Map();
  }
  const key = `${target.mode}:${target.target}`;
  let sender = running.feishuSendersBySource.get(key);
  if (!sender) {
    const proxy = account.proxyUrl || getEnv().PROXY_URL;
    const httpAgent = proxy ? new ProxyAgent(proxy as unknown as any) : undefined;
    sender = new FeishuSender(
      target.target,
      httpAgent,
      account.feishuAppId,
      account.feishuAppSecret,
      {
        mode: target.mode,
        watermark: account.watermark,
        watermarkSecondary: account.watermarkSecondary,
        watermarks: account.watermarks,
        watermarkEnabled: account.watermarkEnabled !== false,
      },
    );
    running.feishuSendersBySource.set(key, sender);
  }
  const uploads = buildScheduledUploads(item);
  const attachments = uploads
    .filter((upload) => upload.url && upload.isImage)
    .map((upload) => ({ url: upload.url as string, filename: upload.filename, isImage: true }));
  const content = typeof item.text === "string" ? item.text : "";
  if (!content.trim() && attachments.length === 0) {
    throw new Error("飞书定时发送仅支持文字或 URL 图片");
  }
  await sender.send({
    content,
    attachments: attachments.length > 0 ? attachments : undefined,
    watermark: target.rule?.watermark,
    watermarkSecondary: target.rule?.watermarkSecondary,
    watermarks: target.rule?.watermarks,
  });
}

async function runScheduledTarget(
  account: AccountConfig,
  running: RunningAccount,
  target: ScheduledTarget,
  schedule: { intervalMinutes: number; contentIds: string[] },
  logger?: FileLogger,
) {
  if (!running.scheduledInFlight) {
    running.scheduledInFlight = new Set();
  }
  if (running.scheduledInFlight.has(target.key)) {
    return;
  }
  running.scheduledInFlight.add(target.key);
  try {
    const items = resolveScheduledContents(account, schedule.contentIds);
    if (items.length === 0) {
      if (logger) {
        logger.warn(`[定时] 规则 ${target.label} 未找到可用内容，已跳过`);
      }
      return;
    }
    for (const item of items) {
      const label = formatScheduledItemLabel(item);
      try {
        if (target.kind === "discord") {
          await dispatchScheduledToDiscord(account, running, target, item);
        } else if (target.kind === "telegram") {
          await dispatchScheduledToTelegram(account, target, item);
        } else if (target.kind === "feishu") {
          await dispatchScheduledToFeishu(account, running, target, item);
        }
        if (logger) {
          logger.info(`[定时] 已发送内容 "${label}" 到 ${target.mappingType} (${target.label})`);
        }
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (logger) {
          logger.error(`[定时] 发送失败 (${target.mappingType} ${target.label}) 内容="${label}" 错误=${msg}`);
        }
      }
    }
  } finally {
    running.scheduledInFlight.delete(target.key);
  }
}

function clearScheduledBroadcasts(running?: RunningAccount) {
  if (!running) return;
  if (running.scheduledJobs) {
    for (const timer of running.scheduledJobs.values()) {
      clearInterval(timer);
    }
  }
  running.scheduledJobs = new Map();
  running.scheduledSenderCache = new Map();
  running.scheduledInFlight = new Set();
}

function refreshScheduledBroadcasts(account: AccountConfig, running: RunningAccount, logger?: FileLogger) {
  clearScheduledBroadcasts(running);
  const targets = collectScheduledTargets(account);
  if (targets.length === 0) return;
  for (const target of targets) {
    const schedule = resolveScheduledConfig(account, target.rule);
    if (!schedule) continue;
    const intervalMs = Math.max(1, schedule.intervalMinutes) * 60 * 1000;
    const timer = setInterval(() => {
      runScheduledTarget(account, running, target, schedule, logger).catch(() => {});
    }, intervalMs);
    running.scheduledJobs?.set(target.key, timer);
    if (logger) {
      logger.info(
        `[定时] 已启用 ${target.mappingType} (${target.label}) 间隔=${schedule.intervalMinutes}分钟 内容数=${schedule.contentIds.length}`,
      );
    }
  }
}

export async function writeStatus(accountId: string, state: string, message?: string) {
  try {
    await fs.mkdir(path.dirname(statusFile), { recursive: true });
    let obj: Record<string, any> = {};
    try {
      const buf = await fs.readFile(statusFile, "utf-8");
      obj = JSON.parse(buf.toString());
    } catch {}
    obj[accountId] = { loginState: state, loginMessage: message || "" };
    await fs.writeFile(statusFile, JSON.stringify(obj, null, 2));
  } catch {}
}

async function writeDiscordLibraryStatus(accountId: string, state: string, message?: string) {
  try {
    await fs.mkdir(path.dirname(discordLibraryStatusFile), { recursive: true });
    let obj: Record<string, any> = {};
    try {
      const buf = await fs.readFile(discordLibraryStatusFile, "utf-8");
      obj = JSON.parse(buf.toString());
    } catch {}
    obj[accountId] = { loginState: state, loginMessage: message || "" };
    await fs.writeFile(discordLibraryStatusFile, JSON.stringify(obj, null, 2));
  } catch {}
}

async function readDiscordLibraryStatusMap(): Promise<Record<string, { loginState?: string; loginMessage?: string }>> {
  try {
    const buf = await fs.readFile(discordLibraryStatusFile, "utf-8");
    return JSON.parse(buf.toString());
  } catch {
    return {};
  }
}

async function primeDiscordLibraryStatus(accounts: DiscordAccountLibrary[]) {
  if (!accounts.length) return;
  const statusMap = await readDiscordLibraryStatusMap();
  let changed = false;
  for (const account of accounts) {
    const entry = statusMap[account.id] || {};
    const loginEnabled = account.loginEnabled !== false;
    const tokenOk = typeof account.token === "string" && account.token.trim();
    if (!loginEnabled) {
      if (entry.loginState !== "idle" || entry.loginMessage !== "未启用") {
        statusMap[account.id] = { loginState: "idle", loginMessage: "未启用" };
        changed = true;
      }
      continue;
    }
    if (!tokenOk) {
      if (entry.loginState !== "error" || entry.loginMessage !== "未配置 Token") {
        statusMap[account.id] = { loginState: "error", loginMessage: "未配置 Token" };
        changed = true;
      }
      continue;
    }
    const state = entry.loginState;
    if (!state || state === "idle" || state === "stopped") {
      statusMap[account.id] = { loginState: "connecting", loginMessage: "正在登录..." };
      changed = true;
    }
  }
  if (changed) {
    try {
      await fs.mkdir(path.dirname(discordLibraryStatusFile), { recursive: true });
      await fs.writeFile(discordLibraryStatusFile, JSON.stringify(statusMap, null, 2));
    } catch {}
  }
}

function buildDiscordShareKey(account: AccountConfig): string | null {
  const token = normalizeDiscordToken(account.token);
  if (!token) return null;
  return `${account.type}:${token}`;
}

function normalizeDiscordToken(raw?: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("bot ")) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

function normalizeDiscordLoginError(error?: string): string {
  const msg = typeof error === "string" ? error : "";
  if (!msg) return "连接失败";
  if (msg.includes("Improper token")) {
    return "Token 无效或被风控（异地/IP），请重新登录或使用代理";
  }
  if (msg.includes("DISCORD_LOGIN_TIMEOUT")) {
    return "登录超时，可能被风控或网络受限";
  }
  if (msg.includes("Request to use mfa")) {
    return "账号开启 MFA，请填写谷歌验证密钥";
  }
  return msg;
}

function getSharedClientByAccountId(accountId: string) {
  const running = runningAccounts.get(accountId);
  if (!running?.sharedKey) return null;
  return sharedDiscordClients.get(running.sharedKey) || null;
}

async function writeStatusForAccount(accountId: string, state: string, message?: string) {
  // 每个实例的状态独立管理，不再同步更新所有共享账号
  await writeStatus(accountId, state, message);
}

function mergeTelegramDialogs(existing: any[], incoming: any[]) {
  const byId = new Map<string, any>();
  for (const entry of existing || []) {
    const id = entry?.id;
    if (!id) continue;
    byId.set(String(id), entry);
  }
  for (const entry of incoming || []) {
    const id = entry?.id;
    if (!id) continue;
    const key = String(id);
    const prev = byId.get(key);
    byId.set(key, prev ? { ...prev, ...entry } : entry);
  }
  return Array.from(byId.values());
}

async function updateTelegramDialogsCacheFromMessage(accountId: string, params: any) {
  try {
    if (!accountId) return;
    const chatId = params?.chat_id ?? params?.chatId;
    if (!chatId) return;
    const idStr = String(chatId);
    const rawTitle = typeof params?.chat_title === "string" ? params.chat_title.trim() : "";
    const rawUsername = typeof params?.chat_username === "string" ? params.chat_username.trim() : "";
    const username = rawUsername.startsWith("@") ? rawUsername.slice(1) : rawUsername;
    let title = rawTitle;
    if (!title && username) title = `@${username}`;
    if (!title) title = idStr;
    let type = typeof params?.chat_type === "string" ? params.chat_type : "";
    if (!type) {
      const numeric = Number(chatId);
      if (Number.isFinite(numeric)) {
        if (numeric < 0) {
          const absStr = String(Math.abs(numeric));
          type = absStr.startsWith("100") ? "supergroup" : "group";
        } else {
          type = "private";
        }
      } else {
        type = "unknown";
      }
    }
    const entry = {
      id: idStr,
      title,
      type,
      username: username || undefined,
      member_count: null,
    };
    let cache: Record<string, any[]> = {};
    try {
      const rawCache = await fs.readFile(telegramDialogsCacheFile, "utf-8");
      cache = JSON.parse(rawCache);
    } catch {}
    const existing = Array.isArray(cache[accountId]) ? cache[accountId] : [];
    const merged = mergeTelegramDialogs(existing, [entry]);
    cache[accountId] = merged;
    await fs.writeFile(telegramDialogsCacheFile, JSON.stringify(cache, null, 2));
  } catch {}
}

// 写入 Discord 服务器/频道缓存
async function writeDiscordGuildsCache(accountId: string, client: any) {
  try {
    if (!client?.guilds?.cache) return;

    const guilds = Array.from(client.guilds.cache.values()).map((g: any) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
    }));

    // 获取用户信息
    const userInfo = client.user ? {
      id: client.user.id,
      username: client.user.username,
      discriminator: client.user.discriminator,
      tag: client.user.tag,
      globalName: client.user.globalName,
      avatar: client.user.avatar,
    } : null;

    // 读取现有缓存
    let cache: Record<string, any> = {};
    try {
      const data = await fs.readFile(discordGuildsCacheFile, "utf-8");
      cache = JSON.parse(data);
    } catch {
      // 文件不存在，使用空对象
    }

    // 更新缓存（包含用户信息和服务器列表）
    cache[accountId] = {
      user: userInfo,
      guilds: guilds,
    };
    await fs.writeFile(discordGuildsCacheFile, JSON.stringify(cache, null, 2));

    // 同时写入频道缓存
    await writeDiscordChannelsCache(accountId, client);
  } catch (e) {
    console.error("写入 Discord 服务器缓存失败:", e);
  }
}

async function writeDiscordChannelsCache(accountId: string, client: any) {
  try {
    if (!client?.guilds?.cache) return;

    // 读取现有缓存
    let cache: Record<string, any[]> = {};
    try {
      const data = await fs.readFile(discordChannelsCacheFile, "utf-8");
      cache = JSON.parse(data);
    } catch {
      // 文件不存在，使用空对象
    }

    // 遍历所有服务器，写入频道
    for (const guild of client.guilds.cache.values()) {
      const key = `${accountId}:${guild.id}`;
      const channels = Array.from((guild as any).channels?.cache?.values() || [])
        .filter((ch: any) => ch.type === 0 || ch.type === 2 || ch.type === 4 || ch.type === 5)
        .map((ch: any) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          parentId: ch.parentId,
        }));
      cache[key] = channels;
    }

    await fs.writeFile(discordChannelsCacheFile, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("写入 Discord 频道缓存失败:", e);
  }
}

// 写入 Telegram 对话缓存
async function writeTelegramDialogsCache(accountId: string, dialogs: any[]) {
  try {
    // 读取现有缓存
    let cache: Record<string, any[]> = {};
    try {
      const data = await fs.readFile(telegramDialogsCacheFile, "utf-8");
      cache = JSON.parse(data);
    } catch {
      // 文件不存在，使用空对象
    }

    // 更新缓存
    cache[accountId] = dialogs;
    await fs.writeFile(telegramDialogsCacheFile, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error("写入 Telegram 对话缓存失败:", e);
  }
}

function formatDiscordUserLabel(user: any): string {
  if (!user) return "";
  const tag = typeof user.tag === "string" ? user.tag.trim() : "";
  if (tag) return tag;
  const username = typeof user.username === "string" ? user.username.trim() : "";
  const discriminator = typeof user.discriminator === "string" ? user.discriminator.trim() : "";
  if (username && discriminator && discriminator !== "0" && discriminator !== "0000") {
    return `${username}#${discriminator}`;
  }
  if (username) return username;
  const globalName = typeof user.globalName === "string" ? user.globalName.trim() : "";
  if (globalName) return globalName;
  if (user.id) return `ID:${user.id}`;
  return "";
}

function buildDiscordLoginMessage(user: any, fallback: string): string {
  const label = formatDiscordUserLabel(user);
  return label ? `${fallback}: ${label}` : fallback;
}

function collectDiscordListenChannels(account: AccountConfig): Set<string> {
  const listenChannels = new Set<string>();
  // 保持监听渠道集合稳定，避免实例暂停时断开连接
  const webhooks = account.channelWebhooks || {};
  const feishuWebhooks = account.channelFeishuWebhooks || {};
  const mappings = (account as any).mappings || [];
  for (const channelId of Object.keys(webhooks)) {
    if (channelId) listenChannels.add(channelId);
  }
  for (const channelId of Object.keys(feishuWebhooks)) {
    if (channelId) listenChannels.add(channelId);
  }
  for (const mapping of mappings) {
    if (mapping?.sourceChannelId) {
      listenChannels.add(String(mapping.sourceChannelId));
    }
    const standbyMainChannelId =
      mapping?.standbyMode?.enabled && typeof mapping?.standbyMode?.mainChannelId === "string"
        ? mapping.standbyMode.mainChannelId.trim()
        : "";
    if (standbyMainChannelId) {
      // 主备模式下需要监听备用频道（B 路），用于接收兜底消息。
      listenChannels.add(standbyMainChannelId);
    }
  }
  const telegramMappings = account.telegramConfig?.mappings || [];
  for (const mapping of telegramMappings) {
    if (mapping?.type === "discord-to-telegram" && mapping.sourceChannelId) {
      listenChannels.add(String(mapping.sourceChannelId));
    }
  }
  return listenChannels;
}

function shouldConnectDiscordListener(account: AccountConfig): { shouldConnect: boolean; listenChannels: Set<string> } {
  const listenChannels = collectDiscordListenChannels(account);
  const shouldConnect = account.loginRequested === true && !!account.token && listenChannels.size > 0;
  return { shouldConnect, listenChannels };
}

async function buildSenderBots(account: AccountConfig, logger: FileLogger) {
  const env = getEnv();
  // 修改为数组类型，支持相同源ID对应多个webhook
  const senderBotsBySource = new Map<string, SenderBot[]>();
  const feishuSendersBySource = new Map<string, FeishuSender>();
  let defaultSenderBot: SenderBot | undefined;
  const prepares: Promise<any>[] = [];

  const feishuWebhooks = account.enableFeishuForward ? account.channelFeishuWebhooks || {} : {};
  const replacements = account.replacementsDictionary || {};
  const proxy = account.proxyUrl || env.PROXY_URL;
  const enableTranslation = account.enableTranslation || false;
  const deepseekApiKey = account.deepseekApiKey;
  const translationProvider = account.translationProvider || "deepseek";
  const translationApiKey = account.translationApiKey || account.deepseekApiKey;
  const translationSecret = account.translationSecret;
  const enableBotRelay = account.enableBotRelay || false;
  const watermark = account.watermark;
  const watermarkSecondary = account.watermarkSecondary;
  const watermarks = account.watermarks;
  const relayById = new Map((account.botRelays || []).map((r) => [r.id, r]));
  // 复用同一个代理实例，避免为每个 webhook 创建独立连接池
  const httpAgent = proxy ? new ProxyAgent(proxy as unknown as any) : undefined;

  // 优先使用 mappings 数组（支持相同源ID的多个规则）
  const mappings = (account as any).mappings || [];
  const webhooks = account.enableDiscordForward !== false ? (account.channelWebhooks || {}) : {};

  if (account.enableDiscordForward !== false) {
    if (mappings.length > 0) {
      // 使用 mappings 数组构建（支持相同源ID多个webhook）
      for (const mapping of mappings) {
        if (!mapping?.sourceChannelId || !mapping?.targetWebhookUrl) continue;
        const channelId = String(mapping.sourceChannelId);
        const webhookUrl = String(mapping.targetWebhookUrl);
        const relayId = account.channelRelayMap?.[channelId];
        const relayToken = relayId ? relayById.get(relayId)?.token?.trim() : undefined;
        const useRelay = enableBotRelay && !!relayToken;
        const sb = new SenderBot({
          replacementsDictionary: replacements,
          webhookUrl,
          httpAgent,
          enableTranslation,
          deepseekApiKey,
          translationProvider,
          translationApiKey,
          translationSecret,
          enableBotRelay: useRelay,
          botRelayToken: relayToken,
          watermark,
          watermarkSecondary,
          watermarks,
          watermarkEnabled: account.watermarkEnabled !== false,
        });
        prepares.push(sb.prepare());
        // 将 SenderBot 添加到数组中
        const existing = senderBotsBySource.get(channelId) || [];
        existing.push(sb);
        senderBotsBySource.set(channelId, existing);
        if (!defaultSenderBot) defaultSenderBot = sb;
      }
    } else if (Object.keys(webhooks).length > 0) {
      // 兼容旧数据：从 channelWebhooks 对象读取
      for (const [channelId, webhookUrl] of Object.entries(webhooks)) {
        const relayId = account.channelRelayMap?.[channelId];
        const relayToken = relayId ? relayById.get(relayId)?.token?.trim() : undefined;
        const useRelay = enableBotRelay && !!relayToken;
        const sb = new SenderBot({
          replacementsDictionary: replacements,
          webhookUrl,
          httpAgent,
          enableTranslation,
          deepseekApiKey,
          translationProvider,
          translationApiKey,
          translationSecret,
          enableBotRelay: useRelay,
          botRelayToken: relayToken,
          watermark,
          watermarkSecondary,
          watermarks,
          watermarkEnabled: account.watermarkEnabled !== false,
        });
        prepares.push(sb.prepare());
        senderBotsBySource.set(channelId, [sb]);
        if (!defaultSenderBot) defaultSenderBot = sb;
      }
    }
  }

  if (Object.keys(feishuWebhooks).length > 0) {
    for (const [channelId, rawTarget] of Object.entries(feishuWebhooks)) {
      const target = parseFeishuTarget(rawTarget);
      if (!target) continue;
      const fs = new FeishuSender(
        target.target,
        httpAgent,
        account.feishuAppId,
        account.feishuAppSecret,
        {
          mode: target.mode,
          watermark,
          watermarkSecondary,
          watermarks,
          watermarkEnabled: account.watermarkEnabled !== false,
        },
      );
      feishuSendersBySource.set(channelId, fs);
    }
  }

  // 检查是否配置了任何转发规则
  const hasDiscordWebhooks = Object.keys(webhooks).length > 0;
  const hasFeishuWebhooks = Object.keys(feishuWebhooks).length > 0;
  const hasTelegramMappings = (account.telegramConfig?.mappings || []).some(
    (m: any) => m.type === 'discord-to-telegram'
  );

  // 如果没有配置任何转发规则（Discord/Feishu/Telegram），且 Discord 转发未关闭，则报错
  if (!defaultSenderBot && !hasFeishuWebhooks && account.enableDiscordForward !== false && !hasTelegramMappings) {
    throw new Error("At least one forwarding rule must be configured (Discord webhook, Feishu webhook, or Telegram mapping).");
  }

  await Promise.all(prepares);

  // 移除重复的 webhook 日志输出，只在日志文件中记录一次
  logger.info(`account "${account.name}" senderBots 构建完成，映射频道数=${senderBotsBySource.size}`);

  return { senderBotsBySource, defaultSenderBot, feishuSendersBySource };
}

function setupTelegramBridgeClient() {
  const bridgeProcess = telegramBridgeManager.getProcess();
  if (!bridgeProcess) {
    console.error("[Main] Telegram Bridge process is not available");
    return;
  }

  if (telegramBridgeClient && telegramBridgeClient.isForProcess(bridgeProcess)) {
    return;
  }

  if (telegramBridgeClient) {
    telegramBridgeClient.destroy();
  }

  telegramBridgeClient = new TelegramBridgeClient(bridgeProcess);
  console.log("[Main] Telegram Bridge IPC client initialized");
  const telegramForwardLogger = new FileLogger();

  telegramBridgeClient.on("telegram_message", async (params) => {
    const incomingAccountId = typeof params?.accountId === "string" ? params.accountId : "";
    if (incomingAccountId) {
      updateTelegramDialogsCacheFromMessage(incomingAccountId, params).catch(() => {});
    }
    const accounts = currentConfig?.accounts || [];
    const receivedAt = Date.now();
    for (const account of accounts) {
      const currentForwardingType = account.forwardingType || 'discord-to-discord';
      if (currentForwardingType !== 'telegram-to-discord' && currentForwardingType !== 'telegram-to-telegram') continue;

      if (account.telegramConfig?.enableTelegramForward === false) continue;
      const allowedTelegramAccountIds = collectTelegramAccountIds(account);
      const telegramAccountTypeMap = collectTelegramAccountTypeMap(account);
      const telegramAccountRoleMap = collectTelegramAccountRoleMap(account);
      const incomingAccountType = params.accountId ? telegramAccountTypeMap.get(params.accountId) : undefined;
      const incomingAccountRole = params.accountId ? telegramAccountRoleMap.get(params.accountId) : undefined;
      if (params.accountId && allowedTelegramAccountIds.size > 0 && !allowedTelegramAccountIds.has(params.accountId)) {
        continue;
      }
      const telegramMappings = account.telegramConfig?.mappings || [];
      const allowedMappingType = currentForwardingType === 'telegram-to-telegram' ? 'telegram-to-telegram' : 'telegram-to-discord';
      const sourceChatId = params.chat_id?.toString();
      const sourceChatUsername =
        typeof params.chat_username === "string" ? params.chat_username : undefined;

      const matchingRules = telegramMappings.filter(
        (m: any) => {
          const mappingType = m.type || "telegram-to-discord";
          if (mappingType !== allowedMappingType) return false;
          const raw = typeof m.sourceChannelId === "string" ? m.sourceChannelId.trim() : "";
          if (!raw) return false;
          return isTelegramSourceMatch(raw, sourceChatId, sourceChatUsername);
        },
      );

      const listenerType = account.telegramConfig?.listenerAccountType;
      const hasListenerRole = hasTelegramRoleAccount(account, "listener");
      const filteredRules =
        allowedMappingType === "telegram-to-telegram" && (listenerType === "bot" || listenerType === "client")
          ? matchingRules.filter(() => {
              if (hasListenerRole && incomingAccountRole !== "listener") return false;
              return listenerType === incomingAccountType;
            })
          : matchingRules;

      if (filteredRules.length === 0) {
        continue;
      }

      const mediaItems = Array.isArray(params.media) ? params.media : [];
      const textParts: string[] = [];
      if (typeof params.text === "string" && params.text.trim()) {
        textParts.push(params.text);
      }
      for (const media of mediaItems) {
        const caption = typeof media?.caption === "string" ? media.caption.trim() : "";
        if (caption) textParts.push(caption);
      }
      let content = textParts.join("\n");
      const globalRequiredGroups = parseKeywordGroups(account.blockedKeywords);
      const globalExcludeGroups = parseKeywordGroups(account.excludeKeywords);
      const globalOcrBlockedGroups = parseKeywordGroups(account.ocrBlockedKeywords);
      const globalOcrTriggerGroups = parseKeywordGroups(account.ocrTriggerKeywords);
      const globalReplacements = account.replacementsDictionary || {};
      const normalizedContent = content;
      const hasText = normalizedContent.trim().length > 0;
      const textPreview = formatLogPreview(normalizedContent, 120);
      const senderLabel = params.from_display_name || params.from_username || "Telegram User";
      const sourceLabelParts: string[] = [];
      if (typeof params.chat_title === "string" && params.chat_title.trim()) {
        sourceLabelParts.push(params.chat_title.trim());
      }
      if (sourceChatUsername) {
        sourceLabelParts.push(`@${sourceChatUsername}`);
      }
      if (sourceChatId) {
        sourceLabelParts.push(`id=${sourceChatId}`);
      }
      const sourceLabel = sourceLabelParts.join(" | ") || sourceChatId || "unknown";
      const sourceMessageId = params.id || params.message_id;
      const forwardTag = currentForwardingType === "telegram-to-telegram" ? "TG->TG" : "TG->DC";
      const formatGroupLabel = (groups: ReturnType<typeof parseKeywordGroups>) => {
        const label = formatKeywordGroups(groups);
        return label ? label : "未设置";
      };
      const logSkip = (reason: string, extra?: string) => {
        const msg =
          `[${forwardTag}] 跳过 | 原因: ${reason} | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
          `文本: ${textPreview}${extra ? ` | ${extra}` : ""}`;
        console.log(msg);
        telegramForwardLogger.info(msg);
      };
      const logOcr = (detail: string) => {
        const msg = `[${forwardTag}][OCR] ${detail} | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel}`;
        console.log(msg);
        telegramForwardLogger.info(msg);
      };
      if (account.dedupeSequentialMessages === true) {
        const sourceKey = `${account.id}:${sourceChatId || sourceChatUsername || "unknown"}`;
        const signature = buildTelegramSequentialSignature(params, content, mediaItems);
        const last = telegramSequentialDedupe.get(sourceKey);
        if (last && last === signature) {
          logSkip("连续重复去重");
          continue;
        }
        telegramSequentialDedupe.set(sourceKey, signature);
      }
      const caseInsensitive = account.caseInsensitiveKeywords ?? true;
      const hasRuleOcrFilters = matchingRules.some(
        (rule: any) =>
          parseKeywordGroups(rule.ocrBlockedKeywords).length > 0 ||
          parseKeywordGroups(rule.ocrTriggerKeywords).length > 0,
      );
      let englishRatio: number | null = null;
      let chineseRatio: number | null = null;

      const isImage = (m: any) =>
        m?.type === "photo" || String(m?.mimeType || "").startsWith("image/");
      const isVideo = (m: any) =>
        m?.type === "video" || String(m?.mimeType || "").startsWith("video/");
      const isAudio = (m: any) =>
        m?.type === "audio" || String(m?.mimeType || "").startsWith("audio/");
      const isDocument = (m: any) =>
        m?.type === "document" && !isImage(m) && !isVideo(m) && !isAudio(m);
      const hasImage = Boolean(params.photo) || mediaItems.some(isImage);
      const hasVideo = Boolean(params.video) || mediaItems.some(isVideo);
      const hasAudio = mediaItems.some(isAudio);
      const hasDocument = Boolean(params.document) || mediaItems.some(isDocument);

      const imageMediaItems = mediaItems.filter((m: any) => m?.localPath && isImage(m));
      const needsOcrCheck =
        globalOcrBlockedGroups.length > 0 || globalOcrTriggerGroups.length > 0 || hasRuleOcrFilters;
      const ocrClient = needsOcrCheck ? getOcrClient(account) : null;
      const ocrTexts: string[] = [];
      let ocrChecked = false;
      let ocrLogged = false;

      const runOcr = async () => {
        if (ocrChecked || !ocrClient) return;
        for (const item of imageMediaItems) {
          if (!item?.localPath) continue;
          const result = await ocrClient.recognizeLocalFile(item.localPath);
          ocrTexts.push(OCRClient.extractText(result));
        }
        ocrChecked = true;
      };
      const logOcrSummary = () => {
        if (ocrLogged) return;
        ocrLogged = true;
        const summaries = ocrTexts
          .map((text) => formatLogPreview(text, 120))
          .filter((text) => text && text !== "(无文本内容)");
        if (summaries.length > 0) {
          logOcr(`识别文本: ${summaries.join(" | ")}`);
        } else {
          logOcr("识别完成：未检测到文字");
        }
      };

      try {
        if (needsOcrCheck && imageMediaItems.length > 0) {
          if (!ocrClient) {
            logOcr("OCR服务器未配置，无法检测图片，跳过转发");
            continue;
          }
          await runOcr();
          logOcrSummary();

          if (globalOcrBlockedGroups.length > 0) {
            let blocked = false;
            let blockedKeywords: string[] = [];
            for (const text of ocrTexts) {
              const { matchedGroups, matchedKeywords } = matchParsedKeywordGroups(text, globalOcrBlockedGroups, {
                caseInsensitive,
              });
              if (matchedGroups.length > 0) {
                blocked = true;
                blockedKeywords = matchedKeywords;
                break;
              }
            }
            if (blocked) {
              logOcr(`命中OCR屏蔽词: ${blockedKeywords.join("、")}`);
              continue;
            }
          }

          if (globalOcrTriggerGroups.length > 0) {
            const triggered = ocrTexts.some(
              (text) =>
                matchParsedKeywordGroups(text, globalOcrTriggerGroups, { caseInsensitive }).matchedGroups.length > 0,
            );
            if (!triggered) {
              logOcr(`未命中OCR触发词: ${formatGroupLabel(globalOcrTriggerGroups)}`);
              continue;
            }
          }
        }
      } catch (e: any) {
        console.error(`[${forwardTag}] OCR过滤异常: ${String(e?.message || e)}`);
      }

      // 图片消息优先执行 OCR 屏蔽逻辑；仅在未被 OCR 屏蔽后再执行文本/忽略类规则。
      if (hasText) {
        try {
          const ratio = getLanguageRatio(normalizedContent);
          if (ratio.total > 0) {
            englishRatio = Math.round(ratio.englishRatio);
            chineseRatio = Math.round(ratio.chineseRatio);
            const englishThreshold = clampPercent(account.ignoreEnglishThreshold, 100);
            const chineseThreshold = clampPercent(account.ignoreChineseThreshold, 100);
            if (account.ignoreEnglish && englishRatio >= englishThreshold) {
              logSkip(`忽略英文(占比${englishRatio}%>=${englishThreshold}%)`);
              continue;
            }
            if (account.ignoreChinese && chineseRatio >= chineseThreshold) {
              logSkip(`忽略中文(占比${chineseRatio}%>=${chineseThreshold}%)`);
              continue;
            }
          }
        } catch (e: any) {
          console.error(`[${forwardTag}] 语言占比过滤异常: ${String(e?.message || e)}`);
        }
      }

      try {
        if (globalRequiredGroups.length > 0 && hasText) {
          const { matchedGroups } = matchParsedKeywordGroups(normalizedContent, globalRequiredGroups, {
            caseInsensitive,
          });
          if (matchedGroups.length === 0) {
            logSkip("未命中全局关键词", `关键词: ${formatGroupLabel(globalRequiredGroups)}`);
            continue;
          }
        }
      } catch (e: any) {
        console.error(`[${forwardTag}] 文本关键词过滤异常: ${String(e?.message || e)}`);
      }

      try {
        if (globalExcludeGroups.length > 0 && hasText) {
          const { matchedGroups, matchedKeywords } = matchParsedKeywordGroups(normalizedContent, globalExcludeGroups, {
            caseInsensitive,
          });
          if (matchedGroups.length > 0) {
            logSkip("命中全局屏蔽词", `命中: ${matchedKeywords.join("、")}`);
            continue;
          }
        }
      } catch (e: any) {
        console.error(`[${forwardTag}] 文本屏蔽词过滤异常: ${String(e?.message || e)}`);
      }

      try {
        if (account.ignoreImages && hasImage) {
          logSkip("已启用忽略图片");
          continue;
        }
        if (account.ignoreVideo && hasVideo) {
          logSkip("已启用忽略视频");
          continue;
        }
        if (account.ignoreAudio && hasAudio) {
          logSkip("已启用忽略音频");
          continue;
        }
        if (account.ignoreDocuments && hasDocument) {
          logSkip("已启用忽略文件");
          continue;
        }
      } catch (e: any) {
        console.error(`[${forwardTag}] 忽略规则检查异常: ${String(e?.message || e)}`);
      }

      for (const rule of filteredRules) {
        const senderDisplayName =
          params.from_display_name ||
          params.from_username ||
          "Telegram User";
        const stripEnglish = account.stripEnglish === true || rule.stripEnglish === true;
        const stripChinese = account.stripChinese === true || rule.stripChinese === true;
        const stripOptions = { stripEnglish, stripChinese };
        try {
          const standby = (rule as RuleLevelConfig).standbyMode;
          const standbyMainChannelId =
            standby?.enabled && typeof standby.mainChannelId === "string" ? standby.mainChannelId.trim() : "";
          const standbyEnabled = Boolean(standbyMainChannelId);
          const isStandbyMainRule = standbyEnabled
            ? isTelegramIdentifierMatch(standbyMainChannelId, rule.sourceChannelId)
            : false;
          const isStandbyMain = standbyEnabled
            ? (isStandbyMainRule || isTelegramStandbyMainChannel(standbyMainChannelId, sourceChatId, sourceChatUsername))
            : false;
          if (standbyEnabled && isStandbyMain) {
            recordTelegramStandbyActivity(standbyMainChannelId);
          }
          const standbyCooldownMs = standbyEnabled ? Math.max(1, Number(standby?.cooldownSeconds) || 60) * 1000 : 0;

          // 规则级别也遵循“图片先 OCR 屏蔽，再执行其他规则”。
          const ruleOcrBlockedGroups = parseKeywordGroups(rule.ocrBlockedKeywords);
          const ruleOcrTriggerGroups = parseKeywordGroups(rule.ocrTriggerKeywords);
          const activeRuleOcrTriggerGroups =
            globalOcrTriggerGroups.length > 0 ? [] : ruleOcrTriggerGroups;

          if (ruleOcrBlockedGroups.length > 0 || activeRuleOcrTriggerGroups.length > 0) {
            if (imageMediaItems.length > 0) {
              if (!ocrClient) {
                logOcr(`OCR服务器未配置，规则触发无法生效 | 目标: ${rule.targetChannelId}`);
                continue;
              }
              if (!ocrChecked) {
                await runOcr();
                logOcrSummary();
              }

              if (ruleOcrBlockedGroups.length > 0) {
                let blocked = false;
                let blockedKeywords: string[] = [];
                for (const text of ocrTexts) {
                  const { matchedGroups, matchedKeywords } = matchParsedKeywordGroups(text, ruleOcrBlockedGroups, {
                    caseInsensitive,
                  });
                  if (matchedGroups.length > 0) {
                    blocked = true;
                    blockedKeywords = matchedKeywords;
                    break;
                  }
                }
                if (blocked) {
                  logOcr(`命中规则OCR屏蔽词: ${blockedKeywords.join("、")} | 目标: ${rule.targetChannelId}`);
                  continue;
                }
              }

              if (activeRuleOcrTriggerGroups.length > 0) {
                const triggered = ocrTexts.some(
                  (text) =>
                    matchParsedKeywordGroups(text, activeRuleOcrTriggerGroups, { caseInsensitive }).matchedGroups.length >
                      0,
                );
                if (!triggered) {
                  logOcr(
                    `未命中规则OCR触发词: ${formatGroupLabel(activeRuleOcrTriggerGroups)} | 目标: ${rule.targetChannelId}`,
                  );
                  continue;
                }
              }
            }
          }

          if (rule.ignoreImages === true && hasImage) {
            logSkip("规则已启用忽略图片", `目标: ${rule.targetChannelId}`);
            continue;
          }
          if (rule.ignoreVideo === true && hasVideo) {
            logSkip("规则已启用忽略视频", `目标: ${rule.targetChannelId}`);
            continue;
          }
          if (rule.ignoreAudio === true && hasAudio) {
            logSkip("规则已启用忽略音频", `目标: ${rule.targetChannelId}`);
            continue;
          }
          if (rule.ignoreDocuments === true && hasDocument) {
            logSkip("规则已启用忽略文件", `目标: ${rule.targetChannelId}`);
            continue;
          }

          if (hasText && englishRatio !== null && chineseRatio !== null) {
            const ruleEnglishThreshold = clampPercent(rule.ignoreEnglishThreshold, 100);
            const ruleChineseThreshold = clampPercent(rule.ignoreChineseThreshold, 100);
            if (rule.ignoreEnglish && englishRatio >= ruleEnglishThreshold) {
              logSkip(
                `规则忽略英文(占比${englishRatio}%>=${ruleEnglishThreshold}%)`,
                `目标: ${rule.targetChannelId}`,
              );
              continue;
            }
            if (rule.ignoreChinese && chineseRatio >= ruleChineseThreshold) {
              logSkip(
                `规则忽略中文(占比${chineseRatio}%>=${ruleChineseThreshold}%)`,
                `目标: ${rule.targetChannelId}`,
              );
              continue;
            }
          }

          const ruleRequiredGroups = parseKeywordGroups(rule.blockedKeywords);
          if (globalRequiredGroups.length === 0 && ruleRequiredGroups.length > 0 && hasText) {
            const { matchedGroups } = matchParsedKeywordGroups(normalizedContent, ruleRequiredGroups, {
              caseInsensitive,
            });
            if (matchedGroups.length === 0) {
              logSkip(
                "未命中规则关键词",
                `关键词: ${formatGroupLabel(ruleRequiredGroups)} | 目标: ${rule.targetChannelId}`,
              );
              continue;
            }
          }

          const ruleExcludeGroups = parseKeywordGroups(rule.excludeKeywords);
          if (ruleExcludeGroups.length > 0 && hasText) {
            const { matchedGroups, matchedKeywords } = matchParsedKeywordGroups(normalizedContent, ruleExcludeGroups, {
              caseInsensitive,
            });
            if (matchedGroups.length > 0) {
              logSkip(
                "命中规则屏蔽词",
                `命中: ${matchedKeywords.join("、")} | 目标: ${rule.targetChannelId}`,
              );
              continue;
            }
          }

          let contentForRule = content;
          if (globalReplacements && Object.keys(globalReplacements).length > 0) {
            for (const [from, to] of Object.entries(globalReplacements)) {
              contentForRule = contentForRule.replaceAll(from, String(to ?? ""));
            }
          }
          if (rule.replacementsDictionary && typeof rule.replacementsDictionary === "object") {
            for (const [from, to] of Object.entries(rule.replacementsDictionary)) {
              contentForRule = contentForRule.replaceAll(from, String(to ?? ""));
            }
          }
          const isTelegramToTelegram = rule.type === "telegram-to-telegram";
          const resolvedLongMessage =
            isTelegramToTelegram && account.telegramLongMessage && !rule.longMessage
              ? account.telegramLongMessage
              : rule.longMessage;
          contentForRule = applyLongMessageConfig(contentForRule, resolvedLongMessage);

          const showSourceIdentity = account.showSourceIdentity === true;
          const replyInfo = params.reply_to || params.reply_to_message;

          if (isTelegramToTelegram && showSourceIdentity && senderDisplayName) {
            const prefix = `👤 ${senderDisplayName}`;
            contentForRule = contentForRule ? `${prefix}\n${contentForRule}` : prefix;
          }

          let useEmbed = true;
          let extraEmbeds: any[] | undefined;
          let avatarUrl: string | undefined;
          let forwardStyle = "style1";

          if (!isTelegramToTelegram) {
            const rawStyle = account.feishuStyle;
            forwardStyle = rawStyle === "style2" || rawStyle === "style3" ? rawStyle : "style1";
            avatarUrl = showSourceIdentity
              ? buildTelegramAvatarUrl(
                  params.from_avatar_file,
                  params.from_avatar_url,
                  account.publicBaseUrl,
                  params.from_username,
                )
              : undefined;
            useEmbed = forwardStyle === "style1" || forwardStyle === "style3";

            if (replyInfo) {
              const replyUser = replyInfo.from_user || {};
              const replyName =
                replyInfo.from_display_name ||
                replyInfo.from_username ||
                `${replyUser.firstName || ""} ${replyUser.lastName || ""}`.trim() ||
                replyUser.username ||
                "用户";
              const replyContent = replyInfo.text || "";

              if (forwardStyle === "style1") {
                const ctaLine = `↳ @${replyName}: ${replyContent || "回复消息"}`;
                contentForRule = [ctaLine, contentForRule].filter(Boolean).join("\n");
              } else {
                useEmbed = forwardStyle !== "style2";
                const replyTitle = `💬 回复 ${replyName}`;
                const replyBody = replyContent || (forwardStyle === "style3" ? "回复消息" : "");
                extraEmbeds = [
                  {
                    color: 0x0000ff,
                    description:
                      forwardStyle === "style3"
                        ? replyBody
                        : `**${replyTitle}**\n${replyBody}`,
                    footer: { text: `⏰ ${formatTimestampFromSeconds(params.date)}` }
                  }
                ];
                if (forwardStyle === "style3" && extraEmbeds[0]) {
                  extraEmbeds[0].title = undefined;
                  extraEmbeds[0].author = undefined;
                  if (typeof extraEmbeds[0].description === "string") {
                    const cleaned = extraEmbeds[0].description
                      .replace(/^(\*\*)?💬 回复[^\n]*\n?/, "")
                      .trim();
                    extraEmbeds[0].description = cleaned || "回复消息";
                  }
                }
              }
            }
          }

          if (forwardStyle === "style3") {
            extraEmbeds = stripEmbedTitles(extraEmbeds);
          }
          extraEmbeds = stripEmbedText(extraEmbeds, stripOptions);

          // 处理附件
          const uploads: Array<{
            url?: string;
            localPath?: string;
            filename: string;
            isImage?: boolean;
            isVideo?: boolean;
          }> = [];
          const seenUploads = new Set<string>();
          const pushUpload = (entry: {
            url?: string;
            localPath?: string;
            filename: string;
            isImage?: boolean;
            isVideo?: boolean;
          }) => {
            const key = entry.localPath || entry.url;
            if (!key || seenUploads.has(key)) return;
            seenUploads.add(key);
            uploads.push(entry);
          };

          if (params.photo) {
            pushUpload({ url: params.photo, filename: "photo.jpg", isImage: true });
          }
          if (params.video) {
            pushUpload({ url: params.video, filename: "video.mp4", isVideo: true });
          }
          if (params.document) {
            pushUpload({ url: params.document, filename: "document" });
          }
          for (const media of mediaItems) {
            if (!media) continue;
            const localPath = typeof media.localPath === "string" ? media.localPath : undefined;
            const url = typeof media.url === "string" ? media.url : undefined;
            if (!localPath && !url) continue;
            const mimeType = typeof media.mimeType === "string" ? media.mimeType : "";
            const isImage = media.type === "photo" || mimeType.startsWith("image/");
            const isVideo = media.type === "video" || mimeType.startsWith("video/");
            const filename =
              (typeof media.fileName === "string" && media.fileName.trim()) ||
              (typeof media.filename === "string" && media.filename.trim()) ||
              (isImage ? "photo.jpg" : isVideo ? "video.mp4" : "file");
            pushUpload({ localPath, url, filename, isImage, isVideo });
          }

          let contentPreview = formatLogPreview(contentForRule);
          const senderLabel = senderDisplayName || "Telegram User";
          const scheduleStandbyForward = async (targetLabel: string, sendFn: () => Promise<void>) => {
            if (!standbyEnabled || isStandbyMain || !standbyMainChannelId) {
              return false;
            }
            const delayMs = standbyCooldownMs;

            const runSend = async () => {
              const lastMainTime = getTelegramStandbyLastActive(standbyMainChannelId);
              if (lastMainTime > receivedAt) {
                const mainAfterMs = Math.max(0, lastMainTime - receivedAt);
                logSkip(
                  `主备模式静默: 主频道(${standbyMainChannelId}) 在观察窗口内有新消息`,
                  `主频道活跃于 ${Math.ceil(mainAfterMs / 1000)}s 内 | 目标: ${targetLabel}`,
                );
                return;
              }
              await sendFn();
            };

            const waitSeconds = Math.ceil(delayMs / 1000);
            const waitMsg =
              `[${forwardTag}] 主备模式等待 | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
              `主频道: ${standbyMainChannelId} | 观察窗口: ${waitSeconds}s | 目标: ${targetLabel} | 文本: ${contentPreview}`;
            console.log(waitMsg);
            telegramForwardLogger.info(waitMsg);
            const key = `standby:${account.id}:${rule.id || targetLabel}:${receivedAt}:${++telegramStandbyPendingSeq}`;
            const timer = setTimeout(() => {
              telegramStandbyPending.delete(key);
              runSend().catch((error: any) => {
                const errorMsg =
                  `[${forwardTag}] 主备延迟转发失败 | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
                  `目标: ${targetLabel} | 错误: ${String(error?.message || error)}`;
                console.error(errorMsg);
                telegramForwardLogger.error(errorMsg);
              });
            }, delayMs);
            telegramStandbyPending.set(key, timer);
            return true;
          };

          if (isTelegramToTelegram) {
            const targetChatId = typeof rule.targetChannelId === "string" ? rule.targetChannelId.trim() : "";
            if (!targetChatId) {
              logSkip("未配置目标 Chat ID", `目标: ${rule.targetChannelId || "空"}`);
              continue;
            }
            const sendChatId = normalizeTelegramChatId(targetChatId);

            const preferredSenderType =
              (rule.senderAccountType === "bot" || rule.senderAccountType === "client")
                ? rule.senderAccountType
                : account.telegramConfig?.defaultSenderAccountType;

            const replySourceId = params.reply_to_message_id || replyInfo?.id;
            const replyTargetId = resolveTelegramReplyTarget(sourceChatId, replySourceId, targetChatId);
            let telegramContent = contentForRule;

            if (account.enableTranslation === true && rule.translateDirection !== "off") {
              const translator = getTranslationSender(account);
              const direction = rule.translateDirection || "auto";
              if (translator && telegramContent.trim()) {
                const target =
                  direction !== "auto"
                    ? (direction as "zh-en" | "en-zh")
                    : translator.chooseTranslateTarget(telegramContent);
                if (target) {
                  const translated = await translator.translateText(telegramContent, target);
                  if (translated) {
                    telegramContent = `${telegramContent}\n---\n${translated}`;
                  }
                }
              }
            }

            const effectiveWatermarks = account.watermarkEnabled === false
              ? []
              : resolveWatermarkList(
                  account.watermarks,
                  rule.watermarks,
                  account.watermark,
                  rule.watermark,
                  account.watermarkSecondary,
                  rule.watermarkSecondary,
                );
            if (!replyTargetId && replyInfo) {
              const replyUser = replyInfo.from_user || {};
              const replyName =
                replyInfo.from_display_name ||
                replyInfo.from_username ||
                `${replyUser.firstName || ""} ${replyUser.lastName || ""}`.trim() ||
                replyUser.username ||
                "用户";
              const replyContent = replyInfo.text || "";
              const ctaLine = `↳ ${replyName}: ${replyContent || "回复消息"}`;
              telegramContent = [ctaLine, telegramContent].filter(Boolean).join("\n");
            }

            if (stripEnglish || stripChinese) {
              telegramContent = stripLanguages(telegramContent, stripOptions);
            }
            contentPreview = formatLogPreview(telegramContent);

            const dispatchTelegram = async () => {
              const bridge = telegramBridgeClient;
              if (!bridge) {
                logSkip("Telegram Bridge 未就绪", `目标: ${targetChatId}`);
                return;
              }

              const { result: sendResult, account: senderAccount } =
                await sendTelegramMessageWithFallback(
                  bridge,
                  account,
                  preferredSenderType,
                  "sender",
                  {
                    chatId: sendChatId,
                    message: {
                      text: telegramContent,
                      reply_to_message_id: replyTargetId,
                      watermark: effectiveWatermarks[0],
                      watermarkSecondary: effectiveWatermarks[1],
                      watermarks: effectiveWatermarks,
                    },
                    media: uploads.length > 0 ? uploads : undefined,
                  },
                  (message) => {
                    const logMsg =
                      `[${forwardTag}] ${message} | 账号: ${account.name} | 目标: ${targetChatId}`;
                    console.warn(logMsg);
                    telegramForwardLogger.info(logMsg);
                  },
                );

              if (!senderAccount) {
                logSkip("未找到可用 Telegram 发送账号", `目标: ${targetChatId}`);
                return;
              }

              if (sendResult?.messageId && sourceChatId && sourceMessageId) {
                recordTelegramReplyMapping(sourceChatId, String(sourceMessageId), targetChatId, String(sendResult.messageId));
              }

              if (sendResult?.success || sendResult?.messageId) {
                const logMsg =
                  `[${forwardTag}] 转发成功 | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
                  `目标: ${targetChatId} | 内容: ${contentPreview} | 附件: ${uploads.length}`;
                console.log(logMsg);
                telegramForwardLogger.info(logMsg);
                recordForwardStat(
                  account.id,
                  currentForwardingType === "telegram-to-telegram" ? "telegram-to-telegram" : "telegram-to-discord",
                );
              } else {
                const errorMsg =
                  `[${forwardTag}] 转发失败 | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
                  `目标: ${targetChatId} | 错误: ${String(sendResult?.error || sendResult?.message || "未知错误")}`;
                console.error(errorMsg);
                telegramForwardLogger.error(errorMsg);
              }
            };

            if (await scheduleStandbyForward(targetChatId, dispatchTelegram)) {
              continue;
            }

            await dispatchTelegram();
          } else {
            const dispatchDiscord = async () => {
              const tempSender = new SenderBot({
                webhookUrl: rule.targetChannelId,
                watermark: account.watermark,
                watermarkSecondary: account.watermarkSecondary,
                watermarks: account.watermarks,
                watermarkEnabled: account.watermarkEnabled !== false,
              });

              await tempSender.sendData([{
                content: contentForRule,
                username: showSourceIdentity ? senderDisplayName : undefined,
                avatarUrl,
                uploads: uploads.length > 0 ? uploads : undefined,
                useEmbed,
                extraEmbeds,
                stripEnglish,
                stripChinese,
                watermark: rule.watermark,
                watermarkSecondary: rule.watermarkSecondary,
                watermarks: rule.watermarks,
              }]);

              const logMsg =
                `[${forwardTag}] 转发成功 | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
                `目标: ${rule.targetChannelId} | 内容: ${contentPreview} | 附件: ${uploads.length}`;
              console.log(logMsg);
              telegramForwardLogger.info(logMsg);
              recordForwardStat(
                account.id,
                currentForwardingType === "telegram-to-telegram" ? "telegram-to-telegram" : "telegram-to-discord",
              );
            };

            if (await scheduleStandbyForward(rule.targetChannelId, dispatchDiscord)) {
              continue;
            }

            await dispatchDiscord();
          }
        } catch (error: any) {
          const errorMsg =
            `[${forwardTag}] 转发失败 | 账号: ${account.name} | 来自: ${senderDisplayName || "Telegram User"} | ` +
            `源: ${sourceLabel} | 目标: ${rule.targetChannelId} | 错误: ${String(error?.message || error)}`;
          console.error(errorMsg);
          telegramForwardLogger.error(errorMsg);
        }
      }
    }
  });

  telegramBridgeClient.on("error", (error) => {
    console.error("[Main] Telegram Bridge IPC error:", error);
  });

  telegramBridgeClient.on("exit", (code) => {
    console.log(`[Main] Telegram Bridge exited with code ${code}`);
    telegramBridgeClient = null;
  });
}

function setupDiscordBridgeClient() {
  const bridgeProcess = discordBridgeManager.getProcess();
  if (!bridgeProcess) {
    console.error("[Main] Discord Bridge process is not available");
    return;
  }

  if (discordBridgeClient && discordBridgeClient.isForProcess(bridgeProcess)) {
    return;
  }

  if (discordBridgeClient) {
    discordBridgeClient.destroy();
  }

  discordBridgeClient = new DiscordBridgeClient(bridgeProcess);
  console.log("[Main] Discord Bridge IPC client initialized");
  const discordForwardLogger = new FileLogger();

  discordBridgeClient.on("discord_message", async (params) => {
    try {
      const accountId = params?.accountId;
      if (!accountId) return;
      const running = runningAccounts.get(accountId);
      if (!running) return;
      await running.bot.handleExternalMessage(params);
    } catch (err: any) {
      discordForwardLogger.error(`Discord bridge message handling failed: ${String(err?.message || err)}`);
    }
  });

  discordBridgeClient.on("discord_status", async (params) => {
    try {
      const accountId = params?.accountId;
      if (!accountId) return;
      const state = params?.state;
      const user = params?.user;
      const isLibraryAccount = Boolean(currentConfig?.discordAccounts?.some((acc) => acc.id === accountId));
      const isInstanceAccount = Boolean(currentConfig?.accounts?.some((acc) => acc.id === accountId));

      const running = runningAccounts.get(accountId);
      if (running && user) {
        running.bot.setSelfUser(user);
      }

      const normalizedError = normalizeDiscordLoginError(params?.error);
      const instanceState =
        state === "online"
          ? { state: "online", message: buildDiscordLoginMessage(user, "登录成功") }
          : state === "connecting"
            ? { state: "pending", message: "正在连接..." }
            : state === "disconnected"
              ? { state: "error", message: "连接已断开" }
            : state === "error"
                ? { state: "error", message: normalizedError }
                : { state: undefined, message: undefined };

      const libraryState =
        state === "online"
          ? { state: "online", message: buildDiscordLoginMessage(user, "已连接") }
          : state === "connecting"
            ? { state: "connecting", message: "正在登录..." }
            : state === "disconnected"
              ? { state: "error", message: "连接已断开" }
            : state === "error"
                ? { state: "error", message: normalizedError }
                : { state: undefined, message: undefined };

      if (isInstanceAccount && instanceState.state) {
        await writeStatusForAccount(accountId, instanceState.state, instanceState.message);
      }

      if (isLibraryAccount && libraryState.state) {
        await writeDiscordLibraryStatus(accountId, libraryState.state, libraryState.message);
        if (state === "online" && currentConfig) {
          for (const acc of currentConfig.accounts) {
            if (acc.discordAccountId !== accountId) continue;
            if (!acc.loginRequested) continue;
            if (runningAccounts.has(acc.id)) continue;
            await discordForwardLogger.info(`账号 ${accountId} 上线，正在启动依赖实例 ${acc.name}...`);
            await startAccount(acc, discordForwardLogger);
          }
        }
      }
    } catch (err: any) {
      discordForwardLogger.error(`Discord bridge status handling failed: ${String(err?.message || err)}`);
    }
  });
}

async function processTelegramLoginRequest(logger: FileLogger) {
  if (telegramLoginProcessing) return;
  telegramLoginProcessing = true;
  try {
    await fs.access(telegramLoginRequestFile);
  } catch {
    telegramLoginProcessing = false;
    return;
  }

  try {
    const raw = await fs.readFile(telegramLoginRequestFile, "utf-8");
    let request: any = null;
    try {
      request = JSON.parse(raw);
    } catch {
      request = null;
    }
    await fs.unlink(telegramLoginRequestFile).catch(() => {});

    try {
      await fs.mkdir(path.dirname(telegramLoginResponseFile), { recursive: true });
    } catch {}

    if (!request || !request.id || !request.action) {
      await fs.writeFile(
        telegramLoginResponseFile,
        JSON.stringify({ id: request?.id || "unknown", success: false, error: "INVALID_REQUEST" }, null, 2),
      );
      telegramLoginProcessing = false;
      return;
    }

    if (!telegramBridgeClient) {
      await fs.writeFile(
        telegramLoginResponseFile,
        JSON.stringify({ id: request.id, success: false, error: "BRIDGE_NOT_READY" }, null, 2),
      );
      telegramLoginProcessing = false;
      return;
    }

    let result: any = null;
    if (request.action === "start") {
      result = await telegramBridgeClient.startClientLogin(request.params || {});
    } else if (request.action === "confirm") {
      result = await telegramBridgeClient.confirmClientLogin(request.params || {});
    } else {
      result = { success: false, error: "UNKNOWN_ACTION" };
    }

    await fs.writeFile(
      telegramLoginResponseFile,
      JSON.stringify(
        {
          id: request.id,
          success: result?.success === true,
          result,
          error: result?.error,
        },
        null,
        2,
      ),
    );
  } catch (e: any) {
    try {
      await fs.writeFile(
        telegramLoginResponseFile,
        JSON.stringify(
          { id: "unknown", success: false, error: String(e?.message || e) },
          null,
          2,
        ),
      );
    } catch {}
    await logger.error(`处理 Telegram 登录请求失败: ${String(e?.message || e)}`);
  } finally {
    telegramLoginProcessing = false;
  }
}

async function processTelegramSyncRequest(logger: FileLogger) {
  if (telegramSyncProcessing) return;
  telegramSyncProcessing = true;
  try {
    const files = await fs.readdir(telegramSyncRequestDir).catch(() => []);
    if (files.length === 0) {
      telegramSyncProcessing = false;
      return;
    }

    await fs.mkdir(telegramSyncResponseDir, { recursive: true });

    for (const file of files) {
      const fullPath = path.join(telegramSyncRequestDir, file);
      let request: any = null;
      let requestId = path.parse(file).name || "unknown";
      try {
        const raw = await fs.readFile(fullPath, "utf-8");
        request = JSON.parse(raw);
      } catch {
        request = null;
      }
      await fs.unlink(fullPath).catch(() => {});

      if (request?.id) {
        requestId = request.id;
      }
      const responsePath = path.join(telegramSyncResponseDir, `${requestId}.json`);

      try {
        if (!request || !request.id || !request.accountId) {
          await fs.writeFile(
            responsePath,
            JSON.stringify({ id: requestId, success: false, error: "INVALID_REQUEST" }, null, 2),
          );
          continue;
        }

        if (!telegramBridgeClient) {
          await fs.writeFile(
            responsePath,
            JSON.stringify({ id: request.id, success: false, error: "BRIDGE_NOT_READY" }, null, 2),
          );
          continue;
        }
        const bridge = telegramBridgeClient;

        const requestAccount = request?.account && typeof request.account === "object" ? request.account : undefined;
        const accountId = String(request.accountId || requestAccount?.id || "");
        let account = currentConfig?.telegramAccounts?.find((acc) => acc.id === accountId);
        if (!account) {
          const rawMulti = await getMultiConfig();
          account = rawMulti.telegramAccounts?.find((acc) => acc.id === accountId);
        }

        if (!account && requestAccount) {
          account = requestAccount;
        }

        if (!account || !accountId) {
          await fs.writeFile(
            responsePath,
            JSON.stringify({ id: request.id, success: false, error: "ACCOUNT_NOT_FOUND" }, null, 2),
          );
          continue;
        }

        const hasBotToken = typeof account.token === "string" && account.token.trim().length > 0;
        const hasSession = Boolean(account.sessionString || account.sessionPath);
        const inferredType = account.type || (hasBotToken && !hasSession ? "bot" : "client");
        const normalizedAccount = {
          ...account,
          id: accountId,
          name: account.name || "Telegram",
          type: inferredType,
        };
        const isBot = normalizedAccount.type === "bot";

        if (isBot) {
          if (!hasBotToken) {
            await fs.writeFile(
              responsePath,
              JSON.stringify({ id: request.id, success: false, error: "BOT_TOKEN_MISSING" }, null, 2),
            );
            continue;
          }
        } else {
          if (!account.apiId || !account.apiHash) {
            await fs.writeFile(
              responsePath,
              JSON.stringify({ id: request.id, success: false, error: "API_CREDENTIALS_MISSING" }, null, 2),
            );
            continue;
          }
          if (!account.sessionString && !account.sessionPath) {
            await fs.writeFile(
              responsePath,
              JSON.stringify({ id: request.id, success: false, error: "SESSION_MISSING" }, null, 2),
            );
            continue;
          }
        }

        let connectResult: any = null;
        try {
          if (isBot) {
            connectResult = await telegramBridgeClient.connectBot({
              id: accountId,
              name: normalizedAccount.name || "",
              type: "bot",
              token: normalizedAccount.token || "",
              proxyUrl: normalizedAccount.proxyUrl,
              enabled: true,
            });
          } else {
            connectResult = await telegramBridgeClient.connectClient({
              id: accountId,
              name: normalizedAccount.name || "",
              type: "client",
              token: normalizedAccount.apiHash || normalizedAccount.token || "",
              apiId: normalizedAccount.apiId,
              apiHash: normalizedAccount.apiHash,
              sessionPath: normalizedAccount.sessionPath,
              sessionString: normalizedAccount.sessionString,
              sessionType: normalizedAccount.sessionType,
              phoneNumber: normalizedAccount.phoneNumber,
              twoFactorPassword: normalizedAccount.twoFactorPassword,
              proxyUrl: normalizedAccount.proxyUrl,
              enabled: true,
            });
          }
        } catch (e: any) {
          await fs.writeFile(
            responsePath,
            JSON.stringify({ id: request.id, success: false, error: String(e?.message || e) }, null, 2),
          );
          continue;
        }

        if (connectResult?.success === false) {
          await fs.writeFile(
            responsePath,
            JSON.stringify(
              { id: request.id, success: false, error: connectResult?.error || connectResult?.message || "CONNECT_FAILED" },
              null,
              2,
            ),
          );
          continue;
        }

        const fetchChannels = async () =>
          isBot
            ? await bridge.getBotChannels(accountId)
            : await bridge.getClientChannels(accountId);

        let channelsResult: any = null;
        try {
          channelsResult = await fetchChannels();
          if (!channelsResult?.success) {
            await new Promise((resolve) => setTimeout(resolve, 1200));
            channelsResult = await fetchChannels();
          }
        } catch (e: any) {
          await fs.writeFile(
            responsePath,
            JSON.stringify({ id: request.id, success: false, error: String(e?.message || e) }, null, 2),
          );
          continue;
        }

        if (!channelsResult?.success) {
          await fs.writeFile(
            responsePath,
            JSON.stringify(
              { id: request.id, success: false, error: channelsResult?.error || channelsResult?.message || "FETCH_FAILED" },
              null,
              2,
            ),
          );
          continue;
        }

        const dialogs = Array.isArray(channelsResult.channels) ? channelsResult.channels : [];
        const note = typeof channelsResult?.note === "string" ? channelsResult.note : "";
        let finalDialogs = dialogs;
        try {
          let cache: Record<string, any[]> = {};
          try {
            const rawCache = await fs.readFile(telegramDialogsCacheFile, "utf-8");
            cache = JSON.parse(rawCache);
          } catch {}
          const existing = Array.isArray(cache[accountId]) ? cache[accountId] : [];
          const merged = mergeTelegramDialogs(existing, dialogs);
          finalDialogs = dialogs.length > 0 ? merged : existing;
          cache[accountId] = finalDialogs;
          await fs.writeFile(telegramDialogsCacheFile, JSON.stringify(cache, null, 2));
        } catch {}

        await fs.writeFile(
          responsePath,
          JSON.stringify(
            {
              id: request.id,
              success: true,
              result: {
                dialogs: finalDialogs,
                dialogsCount: finalDialogs.length,
                userInfo: connectResult?.userInfo || connectResult?.user_info || null,
                note,
              },
            },
            null,
            2,
          ),
        );
      } catch (e: any) {
        await fs.writeFile(
          responsePath,
          JSON.stringify({ id: requestId, success: false, error: String(e?.message || e) }, null, 2),
        );
      }
    }
  } catch (e: any) {
    try {
      await fs.mkdir(telegramSyncResponseDir, { recursive: true });
      await fs.writeFile(
        path.join(telegramSyncResponseDir, "unknown.json"),
        JSON.stringify({ id: "unknown", success: false, error: String(e?.message || e) }, null, 2),
      );
    } catch {}
    await logger.error(`处理 Telegram 同步请求失败: ${String(e?.message || e)}`);
  } finally {
    telegramSyncProcessing = false;
  }
}

async function processDiscordLoginRequest(logger: FileLogger) {
  if (discordLoginProcessing) return;
  discordLoginProcessing = true;
  try {
    await fs.access(discordLoginRequestFile);
  } catch {
    discordLoginProcessing = false;
    return;
  }

  try {
    const raw = await fs.readFile(discordLoginRequestFile, "utf-8");
    let request: any = null;
    try {
      request = JSON.parse(raw);
    } catch {
      request = null;
    }
    await fs.unlink(discordLoginRequestFile).catch(() => {});

    try {
      await fs.mkdir(path.dirname(discordLoginResponseFile), { recursive: true });
    } catch {}

    if (!request || !request.id || !request.action) {
      await fs.writeFile(
        discordLoginResponseFile,
        JSON.stringify({ id: request?.id || "unknown", success: false, error: "INVALID_REQUEST" }, null, 2),
      );
      discordLoginProcessing = false;
      return;
    }

    let result: any = null;
    if (request.action === "password") {
      const email = request.params?.email;
      const password = request.params?.password;
      const totpSecret = request.params?.totpSecret;
      if (!email || !password) {
        result = { success: false, error: "MISSING_CREDENTIALS" };
      } else {
        const client = new SelfBotClient({
          checkUpdate: false,
          patchVoice: false,
          syncStatus: false,
          ...(totpSecret ? { TOTPKey: totpSecret } : {}),
        } as any);
        try {
          const token = await withTimeout(
            (client as any).passLogin(email, password),
            120000,
            "DISCORD_LOGIN",
          );
          const resolvedToken = typeof token === "string" && token.trim() ? token.trim() : (client as any).token;
          if (resolvedToken) {
            result = { success: true, token: resolvedToken };
          } else {
            result = { success: false, error: "TOKEN_NOT_FOUND" };
          }
        } catch (e: any) {
          result = { success: false, error: String(e?.message || e) };
        } finally {
          try {
            await (client as any).destroy();
          } catch {}
        }
      }
    } else {
      result = { success: false, error: "UNKNOWN_ACTION" };
    }

    await fs.writeFile(
      discordLoginResponseFile,
      JSON.stringify(
        {
          id: request.id,
          success: result?.success === true,
          result,
          error: result?.error,
        },
        null,
        2,
      ),
    );
  } catch (e: any) {
    try {
      await fs.writeFile(
        discordLoginResponseFile,
        JSON.stringify({ id: "unknown", success: false, error: String(e?.message || e) }, null, 2),
      );
    } catch {}
    await logger.error(`处理 Discord 登录请求失败: ${String(e?.message || e)}`);
  } finally {
    discordLoginProcessing = false;
  }
}

async function startAccount(
  account: AccountConfig,
  logger: FileLogger,
  sharedInfo?: { sharedKey: string; isPrimary: boolean }
) {
  if (!account.loginRequested) {
    await writeStatusForAccount(account.id, "idle", "未请求登录");
    return;
  }

  await writeStatusForAccount(account.id, "pending", "等待连接...");

  if (!account.token) {
    if (!loggedNoTokenAccounts.has(account.id)) {
      await logger.error(`账号 "${account.name}" 未配置 token，已跳过登录`);
      loggedNoTokenAccounts.add(account.id);
    }
    await writeStatusForAccount(account.id, "error", "未配置 Token");
    return;
  }

  const { shouldConnect, listenChannels } = shouldConnectDiscordListener(account);
  if (!shouldConnect) {
    await writeStatusForAccount(account.id, "idle", "未配置 Discord 监听规则");
  }

  const existing = runningAccounts.get(account.id);
  if (existing) {
    const { senderBotsBySource, defaultSenderBot, feishuSendersBySource } = await buildSenderBots(account, logger);
    const legacyConfig = accountToLegacyConfig(account);
    existing.account = account;
    existing.senderBotsBySource = senderBotsBySource;
    (existing as any).feishuSendersBySource = feishuSendersBySource;
    existing.defaultSenderBot = defaultSenderBot;
    existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);
    refreshScheduledBroadcasts(account, existing, logger);
    if (shouldConnect) {
      await writeStatusForAccount(account.id, "pending", "正在连接...");
    }
    return;
  }

  try {
    const { senderBotsBySource, defaultSenderBot, feishuSendersBySource } = await buildSenderBots(account, logger);
    const legacyConfig = accountToLegacyConfig(account);
    const dummyClient = {} as any;
    const bot = new Bot(dummyClient, legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource, {
      externalMessageSource: true,
    });

    const runningInfo: RunningAccount = {
      account,
      client: dummyClient,
      bot,
      senderBotsBySource,
      defaultSenderBot,
      feishuSendersBySource,
      isManuallyStopped: false,
      reconnectCount: 0,
      lastReconnectTime: 0,
      isLoggingIn: false,
      sharedKey: sharedInfo?.sharedKey,
      sharedPrimary: sharedInfo?.isPrimary,
    };
    runningAccounts.set(account.id, runningInfo);

    // 如果是共享账号且不是 primary，记录日志并跳过客户端创建
    if (sharedInfo && !sharedInfo.isPrimary) {
      await logger.info(`账号 "${account.name}" 共享 Discord 客户端，等待 primary 实例连接`);
      // 将此实例添加到共享客户端的 accountIds 中
      const shared = sharedDiscordClients.get(sharedInfo.sharedKey);
      if (shared) {
        shared.accountIds.add(account.id);
      }
    }

    refreshScheduledBroadcasts(account, runningInfo, logger);

    if (shouldConnect) {
      await writeStatusForAccount(account.id, "pending", "正在连接...");
    }

    if (listenChannels.size === 0) {
      await logger.info(`账号 "${account.name}" 未配置 Discord 监听规则，跳过连接`);
    }
  } catch (e: any) {
    await logger.error(`启动账号 "${account.name}" 失败: ${String(e?.message || e)}`);
    await writeStatusForAccount(account.id, "error", String(e?.message || e));
  }
}

async function stopAccount(accountId: string, logger: FileLogger, manual: boolean = true) {
  const running = runningAccounts.get(accountId);
  if (!running) return;

  clearScheduledBroadcasts(running);
  
  // 标记为手动停止
  if (manual) {
    running.isManuallyStopped = true;
  }
  running.isLoggingIn = false;
  
  // 清除重连定时器
  if (running.reconnectTimer) {
    clearTimeout(running.reconnectTimer);
    running.reconnectTimer = undefined;
  }
  
  try {
    // 清理 Bot 资源（包括定时器等）
    if (running.bot && typeof (running.bot as any).cleanup === "function") {
      await (running.bot as any).cleanup();
    }
  } catch (e: any) {
    await logger.error(`停止账号 "${running.account.name}" 时销毁客户端失败: ${String(e?.message || e)}`);
  }
  runningAccounts.delete(accountId);
  await logger.info(`账号 "${running.account.name}" 已停止`);
  await writeStatus(accountId, "stopped", "已停止");
}

// 自动重连函数
async function reconnectAccount(accountId: string, logger: FileLogger, delay: number = 5000) {
  const running = runningAccounts.get(accountId);
  if (!running) return;

  // 如果是 Bridge 账号（使用外部消息源），不在 Node.js 端执行重连逻辑
  // Bridge 的重连由 Python 进程内部管理
  if (running.bot && (running.bot as any).options?.externalMessageSource) {
    return;
  }

  // 如果手动停止，不重连
  if (running.isManuallyStopped) {
    return;
  }
  
  // 如果已经有重连定时器在运行，不重复创建
  if (running.reconnectTimer) {
    return;
  }
  
  // 检查是否已经连接成功（避免重复重连）
  const client = running.client as any;
  // 更严格的检查：确保 client.user 存在（表示已登录），且 WebSocket 状态为 OPEN (1)
  if (client && client.user && client.ws) {
    const wsState = client.ws.readyState;
    // WebSocket 状态：0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    if (wsState === 1) {
      await logger.info(`账号 "${running.account.name}" 已经连接（readyState=${wsState}），跳过重连`);
      await writeStatusForAccount(
        accountId,
        "online",
        buildDiscordLoginMessage((client as any)?.user, "已连接"),
      );
      // 清除可能存在的重连定时器
      if (running.reconnectTimer) {
        clearTimeout(running.reconnectTimer);
        running.reconnectTimer = undefined;
      }
      return;
    } else {
      await logger.debug(`账号 "${running.account.name}" WebSocket 状态: ${wsState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
    }
  }
  
  // 限制重连次数：如果 5 分钟内重连超过 10 次，停止重连
  const now = Date.now();
  if (now - running.lastReconnectTime > 5 * 60 * 1000) {
    // 超过 5 分钟，重置计数
    running.reconnectCount = 0;
  }
  if (running.reconnectCount >= 10) {
    await logger.error(`账号 "${running.account.name}" 重连次数过多（${running.reconnectCount}次），停止自动重连`);
    await writeStatusForAccount(accountId, "error", "重连次数过多，请检查网络或 Token");
    await stopAccount(accountId, logger, false);
    return;
  }
  
  // 如果账号不再请求登录，不重连
  const currentConfig = await getMultiConfig();
  const account = currentConfig.accounts.find(a => a.id === accountId);
  if (!account || !account.loginRequested) {
    await stopAccount(accountId, logger, false);
    return;
  }
  
  running.reconnectCount++;
  running.lastReconnectTime = now;
  await logger.info(`账号 "${running.account.name}" 将在 ${delay / 1000} 秒后尝试重连... (第 ${running.reconnectCount} 次)`);
  await writeStatusForAccount(accountId, "pending", `连接断开，${delay / 1000} 秒后重连... (${running.reconnectCount}/10)`);
  
  running.reconnectTimer = setTimeout(async () => {
    // 清除定时器引用
    const currentRunning = runningAccounts.get(accountId);
    if (!currentRunning) {
      return;
    }
      currentRunning.reconnectTimer = undefined;
    if (currentRunning.isManuallyStopped) {
      return;
    }
    try {
      // 清理旧的客户端
      // 注意：如果是共享 token 的情况，不要调用 destroy()，否则会影响其他使用相同 token 的实例
      try {
        if ((currentRunning.client as any).destroy && !currentRunning.sharedKey) {
          await (currentRunning.client as any).destroy();
        }
      } catch {}
      
      // 重新创建客户端
      let client: Client;
      if (currentRunning.account.type === "bot") {
        client = new BotClient({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel, Partials.Message, Partials.User],
        }) as any;
      } else {
        // Selfbot 类型的账号由 Discord Bridge (Python) 处理，不在 Node.js 端重连
        await logger.info(`账号 "${currentRunning.account.name}" 是 selfbot 类型，重连由 Discord Bridge 处理`);
        return;
      }
      
      // 重新创建 Bot 实例
      const legacyConfig = accountToLegacyConfig(currentRunning.account);
      const bot = new Bot(client, legacyConfig, currentRunning.defaultSenderBot, currentRunning.senderBotsBySource);
      
      // 更新运行信息
      currentRunning.client = client;
      currentRunning.bot = bot;
      currentRunning.isLoggingIn = true;

      // 在 ready 事件中注册重连处理器，避免重连过程中的临时断开事件
      // 同时监听 ready 和 clientReady 以兼容不同版本
      const readyHandler = async () => {
        const currentRunningAfterReady = runningAccounts.get(accountId);
        if (currentRunningAfterReady) {
          // 重连成功后，清除登录标志
          currentRunningAfterReady.isLoggingIn = false;
          // 清除登录超时定时器
          if (currentRunningAfterReady.loginTimeout) {
            clearTimeout(currentRunningAfterReady.loginTimeout);
            currentRunningAfterReady.loginTimeout = undefined;
          }
          // 现在才注册重连处理器
          setupReconnectHandlers(accountId, logger);
          await writeStatusForAccount(
            accountId,
            "online",
            buildDiscordLoginMessage((currentRunningAfterReady.client as any)?.user, "重连成功"),
          );
          // 重连成功，重置计数
          currentRunningAfterReady.reconnectCount = 0;
          await logger.info(`账号 "${currentRunningAfterReady.account.name}" 重连成功，已注册重连处理器`);
          // 写入服务器/频道缓存
          await writeDiscordGuildsCache(accountId, currentRunningAfterReady.client);
        }
      };
      (client as any).once("clientReady", readyHandler);
      (client as any).once("ready", readyHandler);

      // 设置重连登录超时检查（30秒）
      currentRunning.loginTimeout = setTimeout(() => {
        const timeoutRunning = runningAccounts.get(accountId);
        if (timeoutRunning && timeoutRunning.isLoggingIn) {
          logger.warn(`账号 "${timeoutRunning.account.name}" 重连登录超时 (30秒)，可能是网络问题或账号被风控`);
          writeStatusForAccount(accountId, "error", "重连登录超时，可能是网络问题或需要登录").catch(() => {});
        }
      }, 30000);
      
      // 尝试登录
      try {
        await (client as any).login(currentRunning.account.token);
        // 注意：状态更新和 isLoggingIn 清除现在在 ready 事件中处理
      } catch (e: any) {
        const msg = String(e?.message || e);
        await logger.error(`账号 "${currentRunning.account.name}" 重连失败: ${msg}`);
        await writeStatusForAccount(accountId, "error", `重连失败: ${msg}`);
        currentRunning.isLoggingIn = false;
        // 清除登录超时定时器
        if (currentRunning.loginTimeout) {
          clearTimeout(currentRunning.loginTimeout);
          currentRunning.loginTimeout = undefined;
        }
        
        // 检查是否是Token无效的错误，如果是则不重连
        const isTokenInvalid = msg.includes("TOKEN_INVALID") || 
                              msg.includes("TokenInvalid") || 
                              msg.includes("Token 无效") ||
                              (e?.code === "TokenInvalid");
        
        if (isTokenInvalid) {
          await logger.error(`账号 "${currentRunning.account.name}" Token 无效，停止重连`);
          await writeStatusForAccount(accountId, "error", "Token 无效，请检查 Token 配置");
          await stopAccount(accountId, logger, false);
          return;
        }
        
        // 检查是否应该继续重连
        const shouldRetry = currentRunning && 
                           !currentRunning.isManuallyStopped && 
                           currentRunning.reconnectCount < 10;
        
        if (shouldRetry) {
        // 如果重连失败，再次尝试（指数退避，最多30秒）
        const nextDelay = Math.min(delay * 2, 30000);
        await reconnectAccount(accountId, logger, nextDelay);
        } else {
          await logger.error(`账号 "${currentRunning.account.name}" 停止重连（已达到最大次数或已手动停止）`);
          await stopAccount(accountId, logger, false);
        }
      }
    } catch (e: any) {
      const currentRunning = runningAccounts.get(accountId);
      if (!currentRunning) return;
      
      await logger.error(`账号 "${currentRunning.account.name}" 重连过程出错: ${String(e?.message || e)}`);
      
      // 检查是否应该继续重连
      const shouldRetry = !currentRunning.isManuallyStopped && 
                         currentRunning.reconnectCount < 10;
      
      if (shouldRetry) {
      const nextDelay = Math.min(delay * 2, 30000);
      await reconnectAccount(accountId, logger, nextDelay);
      } else {
        await logger.error(`账号 "${currentRunning.account.name}" 停止重连（已达到最大次数或已手动停止）`);
        await stopAccount(accountId, logger, false);
      }
    }
  }, delay);
}

// 设置重连处理器
function setupReconnectHandlers(accountId: string, logger: FileLogger) {
  const running = runningAccounts.get(accountId);
  if (!running) return;

  // 如果是 Bridge 账号（使用外部消息源），不绑定 Node.js 端的重连监听器
  // Bridge 的连接管理由 Python 进程负责
  if (running.bot && (running.bot as any).options?.externalMessageSource) {
    return;
  }

  if (running.sharedKey && !running.sharedPrimary) {
    return;
  }

  const client = running.client;
  
  // 移除旧的事件监听器（如果存在），避免重复添加
  // 使用 accountId 而不是闭包捕获 running，确保总是获取最新的 running 对象
  const disconnectHandler = async () => {
    const currentRunning = runningAccounts.get(accountId);
    if (!currentRunning || currentRunning.isManuallyStopped) return;
    
    // 检查是否正在登录中，如果是则忽略断开事件（登录过程中可能有临时断开）
    if (currentRunning.isLoggingIn) {
      await logger.debug(`账号 "${currentRunning.account.name}" 登录中，忽略断开事件`);
      return;
    }
    
    // 再次检查连接状态，可能已经自动恢复了
    const client = currentRunning.client as any;
    if (client && client.user && client.ws && client.ws.readyState === 1) {
      await logger.debug(`账号 "${currentRunning.account.name}" 断开事件触发但连接已恢复，跳过重连`);
      return;
    }
    
    await logger.warn(`账号 "${currentRunning.account.name}" 连接断开`);
    await writeStatusForAccount(accountId, "error", "连接断开，正在重连...");
    await reconnectAccount(accountId, logger, 5000);
  };
  
  const shardDisconnectHandler = async () => {
    const currentRunning = runningAccounts.get(accountId);
    if (!currentRunning || currentRunning.isManuallyStopped) return;
    
    // 检查是否正在登录中，如果是则忽略断开事件
    if (currentRunning.isLoggingIn) {
      await logger.debug(`账号 "${currentRunning.account.name}" 登录中，忽略 shard 断开事件`);
      return;
    }
    
    // 再次检查连接状态
    const client = currentRunning.client as any;
    if (client && client.user && client.ws && client.ws.readyState === 1) {
      await logger.debug(`账号 "${currentRunning.account.name}" shard 断开事件触发但连接已恢复，跳过重连`);
      return;
    }
    
    await logger.warn(`账号 "${currentRunning.account.name}" shard 断开`);
    await reconnectAccount(accountId, logger, 5000);
  };
  
  // 移除旧监听器（如果存在）
  (client as any).removeAllListeners("disconnect");
  (client as any).removeAllListeners("shardDisconnect");
  (client as any).removeAllListeners("resume");
  
  // 添加新的事件监听器
  (client as any).on("disconnect", disconnectHandler);
  (client as any).on?.("shardDisconnect", shardDisconnectHandler);
  
  // 监听 resume 事件（重连成功）
  (client as any).on("resume", async () => {
    const currentRunning = runningAccounts.get(accountId);
    if (currentRunning) {
      await logger.info(`账号 "${currentRunning.account.name}" 连接已恢复`);
      await writeStatusForAccount(
        accountId,
        "online",
        buildDiscordLoginMessage((currentRunning.client as any)?.user, "连接已恢复"),
      );
    }
  });
}

async function reconcileAccounts(newConfig: MultiConfig, logger: FileLogger) {
  const oldIds = new Set(runningAccounts.keys());
  const newIds = new Set(newConfig.accounts.map((a) => a.id));

  // 按 sharedKey 分组实例，实现多实例共享同一 Discord 账号
  const sharedKeyGroups = new Map<string, AccountConfig[]>();
  for (const account of newConfig.accounts) {
    if (isExternalForwardingType(account.forwardingType)) continue;
    if (!account.loginRequested || !account.token) continue;
    const sharedKey = buildDiscordShareKey(account);
    if (!sharedKey) continue;
    const group = sharedKeyGroups.get(sharedKey) || [];
    group.push(account);
    sharedKeyGroups.set(sharedKey, group);
  }

  // 记录每个 sharedKey 的 primary 实例（第一个请求登录的实例）
  const primaryBySharedKey = new Map<string, string>();
  for (const [sharedKey, accounts] of sharedKeyGroups) {
    if (accounts.length > 0) {
      primaryBySharedKey.set(sharedKey, accounts[0].id);
      if (accounts.length > 1) {
        await logger.info(`共享账号: ${accounts.length} 个实例使用同一 Discord 账号 (${sharedKey.split(':')[0]})`);
      }
    }
  }

  // 停掉被移除的账号（配置变化导致的停止，不是手动停止）
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      await stopAccount(id, logger, false); // 配置变化导致的停止
    }
  }

  // 新增或更新账号
  for (const account of newConfig.accounts) {
    if (isExternalForwardingType(account.forwardingType)) {
      if (runningAccounts.has(account.id)) {
        await stopAccount(account.id, logger, false);
      }
      continue;
    }
    // 如果账号请求登录但没有 token，跳过处理避免重复错误日志
    if (account.loginRequested && !account.token) {
      const existing = runningAccounts.get(account.id);
      if (!existing && !loggedNoTokenAccounts.has(account.id)) {
        // 只记录一次错误，避免重复日志
        await logger.error(`账号 "${account.name}" 未配置 token，已跳过登录`);
        await writeStatus(account.id, "error", "未配置 Token");
        loggedNoTokenAccounts.add(account.id);
      } else if (existing) {
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
      // 构建共享信息
      const sharedKey = buildDiscordShareKey(account);
      const sharedInfo = sharedKey ? {
        sharedKey,
        isPrimary: primaryBySharedKey.get(sharedKey) === account.id,
      } : undefined;
      await startAccount(account, logger, sharedInfo);
      continue;
    }

    const tokenChanged = account.token !== existing.account.token;
    const typeChanged = account.type !== existing.account.type;
    const oldAccount =
      currentConfig?.accounts.find((a) => a.id === account.id) || existing.account;

    // 检测转发类型变化（discord-to-discord, discord-to-telegram, telegram-to-discord, discord-to-feishu）
    const forwardingTypeChanged = account.forwardingType !== oldAccount.forwardingType;

    const mappingsChanged =
      JSON.stringify(account.channelWebhooks || {}) !== JSON.stringify(oldAccount.channelWebhooks || {}) ||
      JSON.stringify(account.replacementsDictionary || {}) !==
        JSON.stringify(oldAccount.replacementsDictionary || {});
    const ruleConfigChanged =
      JSON.stringify(account.mappings || []) !== JSON.stringify(oldAccount.mappings || []) ||
      JSON.stringify(account.telegramConfig?.mappings || []) !== JSON.stringify(oldAccount.telegramConfig?.mappings || []) ||
      JSON.stringify(account.feishuRuleConfigs || {}) !== JSON.stringify(oldAccount.feishuRuleConfigs || {});
    const relayChanged =
      account.enableBotRelay !== oldAccount.enableBotRelay ||
      JSON.stringify(account.botRelays || []) !== JSON.stringify(oldAccount.botRelays || []) ||
      JSON.stringify(account.channelRelayMap || {}) !== JSON.stringify(oldAccount.channelRelayMap || {});
    // 检测翻译配置变化
    const translationChanged =
      account.enableTranslation !== oldAccount.enableTranslation ||
      account.translationProvider !== oldAccount.translationProvider ||
      account.translationApiKey !== oldAccount.translationApiKey ||
      account.translationSecret !== oldAccount.translationSecret ||
      account.deepseekApiKey !== oldAccount.deepseekApiKey;
    const keywordsChanged =
      JSON.stringify(account.blockedKeywords || []) !== JSON.stringify(oldAccount.blockedKeywords || []) ||
      JSON.stringify(account.excludeKeywords || []) !== JSON.stringify(oldAccount.excludeKeywords || []) ||
      JSON.stringify(account.ocrBlockedKeywords || []) !== JSON.stringify(oldAccount.ocrBlockedKeywords || []) ||
      JSON.stringify(account.ocrTriggerKeywords || []) !== JSON.stringify(oldAccount.ocrTriggerKeywords || []) ||
      account.caseInsensitiveKeywords !== oldAccount.caseInsensitiveKeywords ||
      account.showSourceIdentity !== oldAccount.showSourceIdentity;
    const ocrSettingsChanged = account.ocrServerUrl !== oldAccount.ocrServerUrl;
    const ignoreSettingsChanged =
      account.ignoreSelf !== oldAccount.ignoreSelf ||
      account.ignoreBot !== oldAccount.ignoreBot ||
      account.ignoreImages !== oldAccount.ignoreImages ||
      account.ignoreAudio !== oldAccount.ignoreAudio ||
      account.ignoreVideo !== oldAccount.ignoreVideo ||
      account.ignoreDocuments !== oldAccount.ignoreDocuments ||
      account.ignoreEnglish !== oldAccount.ignoreEnglish ||
      account.ignoreEnglishThreshold !== oldAccount.ignoreEnglishThreshold ||
      account.ignoreChinese !== oldAccount.ignoreChinese ||
      account.ignoreChineseThreshold !== oldAccount.ignoreChineseThreshold ||
      account.stripEnglish !== oldAccount.stripEnglish ||
      account.stripChinese !== oldAccount.stripChinese;
    const translateMapChanged =
      JSON.stringify((account as any).channelTranslate || {}) !== JSON.stringify((oldAccount as any).channelTranslate || {}) ||
      JSON.stringify((account as any).channelTranslateDirection || {}) !== JSON.stringify((oldAccount as any).channelTranslateDirection || {});
    const historyScanChanged =
      JSON.stringify(account.historyScan || {}) !== JSON.stringify(oldAccount.historyScan || {});
    const watermarkChanged =
      JSON.stringify(account.watermarks || []) !== JSON.stringify(oldAccount.watermarks || []) ||
      JSON.stringify(account.watermark || {}) !== JSON.stringify(oldAccount.watermark || {}) ||
      JSON.stringify(account.watermarkSecondary || {}) !== JSON.stringify(oldAccount.watermarkSecondary || {}) ||
      account.watermarkEnabled !== oldAccount.watermarkEnabled;
    const styleChanged = account.feishuStyle !== oldAccount.feishuStyle;
    const forwardSettingsChanged =
      account.enableDiscordForward !== oldAccount.enableDiscordForward ||
      account.enableFeishuForward !== oldAccount.enableFeishuForward;
    const telegramForwardChanged =
      account.telegramConfig?.enableTelegramForward !== oldAccount.telegramConfig?.enableTelegramForward;
    const feishuConfigChanged =
      JSON.stringify(account.channelFeishuWebhooks || {}) !== JSON.stringify(oldAccount.channelFeishuWebhooks || {}) ||
      account.feishuAppId !== oldAccount.feishuAppId ||
      account.feishuAppSecret !== oldAccount.feishuAppSecret;
    const proxyChanged = account.proxyUrl !== oldAccount.proxyUrl;
    const scheduledChanged =
      JSON.stringify(account.scheduledContents || []) !== JSON.stringify(oldAccount.scheduledContents || []) ||
      JSON.stringify(account.scheduledBroadcast || {}) !== JSON.stringify(oldAccount.scheduledBroadcast || {});
    // 检测用户过滤配置变化
    const userFilterChanged =
      JSON.stringify(account.allowedUsersIds || []) !== JSON.stringify(oldAccount.allowedUsersIds || []) ||
      JSON.stringify(account.mutedUsersIds || []) !== JSON.stringify(oldAccount.mutedUsersIds || []);
    const restartRequested = account.restartNonce !== oldAccount.restartNonce;
    // loginRequested 从 false 变为 true 时才认为是登录请求变化
    // loginNonce 的变化不应该触发重启（它只是用于触发登录，不应该在已登录时触发重启）
    const loginRequestedChanged = account.loginRequested !== oldAccount.loginRequested;
    const loginRequestedBecameTrue = !oldAccount.loginRequested && account.loginRequested;

    // 如果账号已经在运行且登录成功，检查是否需要重启
    const isAlreadyLoggedIn = existing.client && (existing.client as any).user;
    
    // 如果账号已经登录，且没有需要重启的变化，尝试热更新
    if (isAlreadyLoggedIn && 
        !tokenChanged && 
        !typeChanged && 
        !restartRequested &&
        !loginRequestedBecameTrue) {
      // 如果是停止请求（loginRequested 从 true 变为 false），需要停止账号（手动停止）
      if (loginRequestedChanged && account.loginRequested === false && existing.account.loginRequested === true) {
        await stopAccount(account.id, logger, true); // 手动停止
        continue;
      }

      // 如果有配置变化，进行热更新（不重启）
      if (
        mappingsChanged ||
        ruleConfigChanged ||
        translationChanged ||
        keywordsChanged ||
        ocrSettingsChanged ||
        ignoreSettingsChanged ||
        translateMapChanged ||
        historyScanChanged ||
        userFilterChanged ||
        relayChanged ||
        watermarkChanged ||
        styleChanged ||
        forwardSettingsChanged ||
        telegramForwardChanged ||
        feishuConfigChanged ||
        proxyChanged ||
        forwardingTypeChanged ||
        scheduledChanged
      ) {
        let senderBotsBySource = existing.senderBotsBySource;
        let defaultSenderBot = existing.defaultSenderBot;
        let feishuSendersBySource = (existing as any).feishuSendersBySource;
        // 如果映射或翻译配置变化，需要重新构建 SenderBot
        // 注意：ruleConfigChanged 包含 mappings 数组的变化，支持相同源ID多个webhook
        if (
          mappingsChanged ||
          ruleConfigChanged ||
          translationChanged ||
          relayChanged ||
          watermarkChanged ||
          forwardSettingsChanged ||
          feishuConfigChanged ||
          proxyChanged
        ) {
          try {
            const built = await buildSenderBots(account, logger);
            senderBotsBySource = built.senderBotsBySource;
            defaultSenderBot = built.defaultSenderBot;
            feishuSendersBySource = built.feishuSendersBySource;
          } catch (e: any) {
            await logger.error(`账号 "${account.name}" 重新构建 SenderBot 失败: ${String(e?.message || e)}`);
            await writeStatus(account.id, "error", `配置错误: ${String(e?.message || e)}`);
            continue; // 跳过这个账号，不更新配置
          }
        }

        const legacyConfig = accountToLegacyConfig(account);
        existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);
        existing.account = account;
        existing.senderBotsBySource = senderBotsBySource;
        existing.defaultSenderBot = defaultSenderBot;
        (existing as any).feishuSendersBySource = feishuSendersBySource;
        if (ruleConfigChanged || scheduledChanged || forwardingTypeChanged || telegramForwardChanged) {
          refreshScheduledBroadcasts(account, existing, logger);
        }

        // 如果转发类型变化，记录日志
        if (forwardingTypeChanged) {
          await logger.info(`账号 "${account.name}" 转发类型已从 "${oldAccount.forwardingType || 'discord-to-discord'}" 切换为 "${account.forwardingType || 'discord-to-discord'}"`);
        }

        await logger.info(`账号 "${account.name}" 配置已热更新（无需重启）`);
        continue;
      }

      // 其他情况（包括只是 loginNonce 变化），跳过处理
      continue;
    }

    // 如果账号未请求登录，且当前正在运行，需要停止（手动停止）
    if (!account.loginRequested && isAlreadyLoggedIn) {
      await stopAccount(account.id, logger, true); // 手动停止
      continue;
    }

    // 没有任何变化则跳过
      if (
        !typeChanged &&
        !tokenChanged &&
        !mappingsChanged &&
        !ruleConfigChanged &&
        !translationChanged &&
        !keywordsChanged &&
        !ocrSettingsChanged &&
        !ignoreSettingsChanged &&
        !translateMapChanged &&
        !historyScanChanged &&
        !userFilterChanged &&
        !relayChanged &&
        !watermarkChanged &&
        !styleChanged &&
        !forwardSettingsChanged &&
        !telegramForwardChanged &&
        !feishuConfigChanged &&
        !proxyChanged &&
        !restartRequested &&
        !loginRequestedBecameTrue &&
        !forwardingTypeChanged
      ) {
      continue;
    }

    // 只有在真正需要重启时才重启（配置变化导致的停止，不是手动停止）
    // loginRequestedBecameTrue 表示从 false 变为 true，需要启动账号
    if (typeChanged || tokenChanged || restartRequested || loginRequestedBecameTrue) {
      await stopAccount(account.id, logger, false); // 配置变化导致的停止
      // 构建共享信息
      const sharedKey = buildDiscordShareKey(account);
      const sharedInfo = sharedKey ? {
        sharedKey,
        isPrimary: primaryBySharedKey.get(sharedKey) === account.id,
      } : undefined;
      await startAccount(account, logger, sharedInfo);
      continue;
    }

    let senderBotsBySource = existing.senderBotsBySource;
    let defaultSenderBot = existing.defaultSenderBot;
    let feishuSendersBySource = (existing as any).feishuSendersBySource;
    // 如果映射或翻译配置变化，需要重新构建 SenderBot
    if (mappingsChanged || translationChanged || relayChanged || forwardSettingsChanged || feishuConfigChanged || proxyChanged) {
      try {
      const built = await buildSenderBots(account, logger);
      senderBotsBySource = built.senderBotsBySource;
      defaultSenderBot = built.defaultSenderBot;
        feishuSendersBySource = built.feishuSendersBySource;
      } catch (e: any) {
        await logger.error(`账号 "${account.name}" 重新构建 SenderBot 失败: ${String(e?.message || e)}`);
        await writeStatus(account.id, "error", `配置错误: ${String(e?.message || e)}`);
        continue; // 跳过这个账号，不更新配置
      }
    }

    const legacyConfig = accountToLegacyConfig(account);
    existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);
    existing.account = account;
    existing.senderBotsBySource = senderBotsBySource;
    existing.defaultSenderBot = defaultSenderBot;
    (existing as any).feishuSendersBySource = feishuSendersBySource;

    if (
      keywordsChanged ||
      ocrSettingsChanged ||
      ignoreSettingsChanged ||
      translateMapChanged ||
      historyScanChanged ||
      mappingsChanged ||
      ruleConfigChanged ||
      translationChanged ||
      relayChanged ||
      watermarkChanged ||
      styleChanged ||
      forwardSettingsChanged ||
      telegramForwardChanged ||
      feishuConfigChanged ||
      proxyChanged
    ) {
      await logger.info(`账号 "${account.name}" 配置已热更新`);
    }
  }

  // 同步配置到Telegram Bridge
  try {
    await syncConfigToTelegramBridge(newConfig);
  } catch (error: any) {
    await logger.error(`同步配置到Telegram Bridge失败: ${error.message}`);
  }

  // 同步配置到 Discord Bridge
  try {
    await syncConfigToDiscordBridge(newConfig);
  } catch (error: any) {
    await logger.error(`同步配置到Discord Bridge失败: ${error.message}`);
  }

  // 同步外部平台转发（X / TruthSocial）
  try {
    await reconcileExternalForwarders(newConfig, logger);
  } catch (error: any) {
    await logger.error(`同步外部平台转发失败: ${error.message}`);
  }

  currentConfig = newConfig;
}

async function main() {
  const logger = new FileLogger();

  // 在启动时先确保文件存在。这是唯一一次允许创建默认文件的机会。
  // 之后的热重载只负责读取，不会创建文件，避免在原子保存间隙时覆盖配置
  await ensureConfigFile();
  await preloadWatermarkFonts();

  const rawMulti = await getMultiConfig();
  const multi = resolveMultiConfigForRuntime(rawMulti);
  currentConfig = multi;

  // 重启项目时不自动启动实例，重置所有账号的 loginRequested 为 false
  await logger.info("系统启动，重置所有实例状态（需手动启动）...");
  for (const account of multi.accounts) {
    account.loginRequested = false;
    await writeStatus(account.id, "idle", "等待手动启动");
  }
  // 保存重置后的配置
  await saveMultiConfig(multi);


  // 按 sharedKey 分组实例，实现多实例共享同一 Discord 账号
  const startupSharedKeyGroups = new Map<string, AccountConfig[]>();
  for (const account of multi.accounts) {
    if (isExternalForwardingType(account.forwardingType)) continue;
    if (!account.loginRequested || !account.token) continue;
    const sharedKey = buildDiscordShareKey(account);
    if (!sharedKey) continue;
    const group = startupSharedKeyGroups.get(sharedKey) || [];
    group.push(account);
    startupSharedKeyGroups.set(sharedKey, group);
  }

  // 记录每个 sharedKey 的 primary 实例
  const startupPrimaryBySharedKey = new Map<string, string>();
  for (const [sharedKey, accounts] of startupSharedKeyGroups) {
    if (accounts.length > 0) {
      startupPrimaryBySharedKey.set(sharedKey, accounts[0].id);
      if (accounts.length > 1) {
        await logger.info(`共享账号: ${accounts.length} 个实例使用同一 Discord 账号 (${sharedKey.split(':')[0]})`);
      }
    }
  }

  // 只启动已请求登录的账号，不自动登录
  for (const account of multi.accounts) {
    if (isExternalForwardingType(account.forwardingType)) {
      continue;
    }
    if (account.loginRequested && account.token) {
      // 构建共享信息
      const sharedKey = buildDiscordShareKey(account);
      const sharedInfo = sharedKey ? {
        sharedKey,
        isPrimary: startupPrimaryBySharedKey.get(sharedKey) === account.id,
      } : undefined;
      await startAccount(account, logger, sharedInfo);
    } else {
      // 确保未请求登录的账号状态正确
      await writeStatus(account.id, "idle", "未请求登录");
    }
  }

  // 启动外部平台转发（X / TruthSocial）
  await reconcileExternalForwarders(multi, logger);

  // 启动 Discord Bridge 进程（按需）
  try {
    await ensureDiscordBridgeRunning(multi);
    await syncConfigToDiscordBridge(multi);
  } catch (error: any) {
    console.error(`[Main] Error starting Discord Bridge: ${error.message}`);
  }

  // 启动Telegram Bridge进程
  try {
    console.log("[Main] Starting Telegram Bridge...");
    telegramBridgeManager.on("started", async () => {
      setupTelegramBridgeClient();
      if (currentConfig) {
        try {
          // 等待 IPC 服务器准备好
          await new Promise(resolve => setTimeout(resolve, 1000));
          await syncConfigToTelegramBridge(currentConfig);
          console.log("[Main] Config synced to Telegram Bridge, enabled accounts will auto-connect");
        } catch (error: any) {
          console.error(`[Main] Failed to sync config to Telegram Bridge: ${error?.message || error}`);
        }
      }
    });

    const bridgeResult = await telegramBridgeManager.start();
    if (bridgeResult.success) {
      console.log(`[Main] Telegram Bridge started successfully (PID: ${bridgeResult.pid})`);
    } else {
      console.error(`[Main] Failed to start Telegram Bridge: ${bridgeResult.message}`);
    }
  } catch (error: any) {
    console.error(`[Main] Error starting Telegram Bridge: ${error.message}`);
  }

  const cfgPath = getConfigPath();
  let pendingReload: NodeJS.Timeout | null = null;
  let checking = false; // 防止并发检查

  // 检查配置文件是否真的变化了（异步版本，不阻塞事件循环）
  const hasConfigChanged = async (): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      stat(cfgPath, async (err, stats) => {
        if (err) {
          resolve(false);
          return;
        }
        
      // 如果修改时间相同，说明文件没有变化
      if (stats.mtimeMs === lastConfigMtime) {
          resolve(false);
          return;
      }
      
        try {
      // 读取文件内容并计算 hash
      const content = await fs.readFile(cfgPath, "utf-8");
      const hash = createHash("md5").update(content).digest("hex");
      
      // 如果 hash 相同，说明内容没有变化
      if (hash === lastConfigHash) {
        lastConfigMtime = stats.mtimeMs; // 更新修改时间，避免下次重复读取
            resolve(false);
            return;
      }
      
      // 文件内容变化了
      lastConfigHash = hash;
      lastConfigMtime = stats.mtimeMs;
          resolve(true);
    } catch (e) {
          // 读取失败，返回 false
          resolve(false);
    }
      });
    });
  };

  const scheduleReload = async () => {
    if (pendingReload || checking) return; // 防止并发
    checking = true;
    
    if (pendingReload) clearTimeout(pendingReload);
    pendingReload = setTimeout(async () => {
      pendingReload = null;
      try {
        // 检查是否有触发文件（API 直接触发的操作）
        const triggerPath = path.resolve(process.cwd(), ".data", "trigger_reload");
        let shouldReload = false;
        try {
          await fs.access(triggerPath);
          // 删除触发文件
          await fs.unlink(triggerPath);
          shouldReload = true;
        } catch {
          // 触发文件不存在，检查配置文件是否变化
          shouldReload = await hasConfigChanged();
        }
        
        if (!shouldReload) {
          return; // 没有变化，跳过处理
        }
        
        // 读取配置时可能遇到原子保存间隙（文件暂时不存在），需要重试
        let latest: MultiConfig | null = null;
        let retries = 3;
        while (retries > 0 && !latest) {
          try {
            latest = await getMultiConfig();
          } catch (e: any) {
            retries--;
            if (retries > 0) {
              // 可能是原子保存间隙，等待一小段时间后重试
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              // 重试失败，记录错误但不中断程序
              console.error("读取配置文件失败（可能是原子保存间隙）", e);
              await logger.error(`读取配置文件失败: ${String(e?.message || e)}`);
              return; // 放弃本次重载，等待下次轮询
            }
          }
        }
        
        if (latest) {
          const resolvedLatest = resolveMultiConfigForRuntime(latest);
          await reconcileAccounts(resolvedLatest, logger);
        }
      } catch (e: any) {
        console.error("自动重载配置失败", e);
        await logger.error(`自动重载配置失败: ${String(e?.message || e)}`);
      } finally {
        checking = false; // 确保在所有情况下都重置标志
      }
    }, 100); // 缩短延迟到 100ms，更快响应
  };

  try {
    watch(cfgPath, { persistent: true }, scheduleReload);
    await logger.info(`已开始监听配置文件: ${cfgPath}`);
  } catch (e: any) {
    await logger.error(`无法监听配置文件: ${cfgPath}, 错误: ${String(e?.message || e)}`);
  }

  // 轮询兜底，每 2 秒检查一次触发文件（API 触发的操作）
  setInterval(() => {
    scheduleReload();
  }, 2000);

  // 处理 Telegram 手机号登录请求
  setInterval(() => {
    processTelegramLoginRequest(logger).catch(() => {});
  }, 1000);

  // 处理 Telegram 同步请求
  setInterval(() => {
    processTelegramSyncRequest(logger).catch(() => {});
  }, 1000);

  // 处理 Discord 邮箱密码登录请求
  setInterval(() => {
    processDiscordLoginRequest(logger).catch(() => {});
  }, 1000);
}

process.on("unhandledRejection", async (reason: any) => {
  const logger = new FileLogger();
  await logger.error(String(reason?.stack || reason));
});

process.on("uncaughtException", async (err: any) => {
  const logger = new FileLogger();
  await logger.error(String(err?.stack || err));
});

// 优雅关闭处理
process.on("SIGINT", async () => {
  console.log("[Main] Received SIGINT, shutting down...");
  shutdownExternalForwarders();
  await telegramBridgeManager.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[Main] Received SIGTERM, shutting down...");
  shutdownExternalForwarders();
  await telegramBridgeManager.cleanup();
  process.exit(0);
});

/**
 * 同步配置到Telegram Bridge进程
 */
async function syncConfigToTelegramBridge(config: MultiConfig) {
  // 检查Telegram Bridge是否在运行
  if (!telegramBridgeManager.isRunning()) {
    return;
  }

  // 提取Telegram相关配置
  const telegramAccountsById = new Map<string, any>();
  const watchSummaryLines: string[] = [];
  const roleRank = { listener: 1, sender: 2 } as const;
  const mergeTelegramAccount = (tgAccount: any) => {
    if (!tgAccount || !tgAccount.id) return;
    const existing = telegramAccountsById.get(tgAccount.id);
    if (!existing) {
      telegramAccountsById.set(tgAccount.id, { ...tgAccount });
      return;
    }
    // 合并字段，优先保留已有的有效值，必要时升级 role/启用状态
    if (!existing.name && tgAccount.name) existing.name = tgAccount.name;
    if (!existing.type && tgAccount.type) existing.type = tgAccount.type;
    if (!existing.token && tgAccount.token) existing.token = tgAccount.token;
    if (!existing.sessionPath && tgAccount.sessionPath) existing.sessionPath = tgAccount.sessionPath;
    if (!existing.sessionString && tgAccount.sessionString) existing.sessionString = tgAccount.sessionString;
    if (!existing.sessionType && tgAccount.sessionType) existing.sessionType = tgAccount.sessionType;
    if (!existing.apiId && tgAccount.apiId) existing.apiId = tgAccount.apiId;
    if (!existing.apiHash && tgAccount.apiHash) existing.apiHash = tgAccount.apiHash;
    if (!existing.proxyUrl && tgAccount.proxyUrl) existing.proxyUrl = tgAccount.proxyUrl;
    if (tgAccount.enabled === true) existing.enabled = true;
    const existingRank = existing.role ? roleRank[existing.role as keyof typeof roleRank] || 0 : 0;
    const nextRank = tgAccount.role ? roleRank[tgAccount.role as keyof typeof roleRank] || 0 : 0;
    if (nextRank > existingRank) {
      existing.role = tgAccount.role;
    } else if (!existing.role && tgAccount.role) {
      existing.role = tgAccount.role;
    }
  };
  const telegramMappings = [];

  for (const account of config.accounts) {
    if (account.telegramConfig) {
      const telegramForwardEnabled = account.telegramConfig?.enableTelegramForward !== false;
      const mappingSummaryTargets = (account.telegramConfig.mappings || [])
        .filter((mapping) => mapping?.sourceChannelId && mapping?.targetChannelId)
        .map((mapping) => ({
          type: mapping.type || "telegram-to-discord",
          source: String(mapping.sourceChannelId),
          target: String(mapping.targetChannelId),
        }));
      if (telegramForwardEnabled && mappingSummaryTargets.length > 0) {
        const uniqSources = Array.from(new Set(mappingSummaryTargets.map((m) => m.source)));
        const uniqTargets = Array.from(new Set(mappingSummaryTargets.map((m) => m.target)));
        const uniqTypes = Array.from(new Set(mappingSummaryTargets.map((m) => m.type)));
        const formatList = (items: string[], limit = 6) => {
          if (items.length <= limit) return items.join(", ");
          return `${items.slice(0, limit).join(", ")}...(共${items.length})`;
        };
        const instanceLabel = account.name || account.id;
        const listenerLabel = account.telegramListenerAccountId || "未选";
        const senderLabel = account.telegramSenderAccountId || "未选";
        watchSummaryLines.push(
          `实例 ${instanceLabel} | 类型=${uniqTypes.join("/") || "未知"} | 监听=${formatList(uniqSources)} | 目标=${formatList(uniqTargets)} | 监听账号=${listenerLabel} | 发送账号=${senderLabel}`,
        );
      }
      // 添加Telegram账号
      if (account.telegramConfig.accounts) {
        for (const tgAccount of account.telegramConfig.accounts) {
          // 对于 bot 类型，优先使用最新的 telegramBotToken（如果存在）
          // 这样当用户更新 token 后，不会使用缓存的旧 token
          let tokenToUse = tgAccount.token || "";
          const shouldOverrideLegacyBot =
            tgAccount.type === "bot" &&
            account.telegramBotToken &&
            (!tgAccount.role || tgAccount.id === `${account.id}_bot`);
          if (shouldOverrideLegacyBot) {
            tokenToUse = account.telegramBotToken || "";
          }
          mergeTelegramAccount({
            id: tgAccount.id,
            name: tgAccount.name,
            type: tgAccount.type,
            token: tokenToUse,
            sessionPath: tgAccount.sessionPath,
            sessionString: tgAccount.sessionString,
            sessionType: tgAccount.sessionType,
            apiId: tgAccount.apiId,
            apiHash: tgAccount.apiHash,
            proxyUrl: tgAccount.proxyUrl,
            role: tgAccount.role,
            enabled: telegramForwardEnabled && tgAccount.enabled !== false
          });
        }
      }

      const hasExplicitClient = (account.telegramConfig.accounts || []).some(
        (tgAccount) => tgAccount.type === "client" || tgAccount.id === account.id,
      );
      const hasExplicitBot = (account.telegramConfig.accounts || []).some(
        (tgAccount) => tgAccount.type === "bot",
      );
      const hasLegacyClientConfig = Boolean(
        (account.telegramSessionPath || account.telegramSessionString) &&
        account.telegramApiId &&
        account.telegramApiHash,
      );
      const hasLegacyBotConfig = Boolean(account.telegramBotToken);

      // 如果有 legacy bot token 且没有显式的 bot 账号，创建一个 bot 账号
      if (!hasExplicitBot && hasLegacyBotConfig) {
        // 检查是否有对应的 bot 状态条目（用户可能手动断开过）
        const botStatusId = `${account.id}_bot`;
        const existingBotEntry = (account.telegramConfig.accounts || []).find(
          (tgAccount) => tgAccount.id === botStatusId
        );
        mergeTelegramAccount({
          id: botStatusId,
          name: `${account.name || "Telegram"} Bot`,
          type: "bot",
          token: account.telegramBotToken,
          sessionType: account.sessionType,
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          proxyUrl: account.proxyUrl,
          // 优先使用已保存的 enabled 状态，否则默认 false
          enabled:
            telegramForwardEnabled && (existingBotEntry ? existingBotEntry.enabled !== false : false),
        });
      }

      // 如果有 legacy client 配置（session）且没有显式的 client 账号，创建一个 client 账号
      if (!hasExplicitClient && hasLegacyClientConfig) {
        // 检查是否有对应的 client 状态条目（用户可能手动断开过）
        const existingClientEntry = (account.telegramConfig.accounts || []).find(
          (tgAccount) => tgAccount.id === account.id
        );
        mergeTelegramAccount({
          id: account.id,
          name: account.name || "Telegram Client",
          type: "client",
          token: account.telegramApiHash || "",
          sessionPath: account.telegramSessionPath,
          sessionString: account.telegramSessionString,
          sessionType: account.sessionType,
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          proxyUrl: account.proxyUrl,
          // 优先使用已保存的 enabled 状态，否则默认 false
          enabled:
            telegramForwardEnabled && (existingClientEntry ? existingClientEntry.enabled !== false : false),
        });
      }

      // 添加Telegram映射，并附带 Discord 账号的 showSourceIdentity 设置
      if (account.telegramConfig.mappings && telegramForwardEnabled) {
        for (const mapping of account.telegramConfig.mappings) {
          telegramMappings.push({
            ...mapping,
            showSourceIdentity: account.showSourceIdentity === true,
            senderAccountId: account.telegramSenderAccountId || undefined,
          });
        }
      }
    }
  }

  // 发送配置更新消息到Telegram Bridge
  const configUpdateMessage = {
    type: "request",
    id: `config_sync_${Date.now()}`,
    method: "updateConfig",
    params: {
      accounts: Array.from(telegramAccountsById.values()),
      mappings: telegramMappings
    }
  };

  const payloadJson = JSON.stringify(configUpdateMessage.params || {});
  const payloadHash = createHash("md5").update(payloadJson).digest("hex");
  if (payloadHash === lastTelegramConfigPayloadHash) {
    return;
  }

  const messageSent = telegramBridgeManager.sendMessage(JSON.stringify(configUpdateMessage));
  if (messageSent) {
    lastTelegramConfigPayloadHash = payloadHash;
    if (watchSummaryLines.length > 0) {
      const summary = watchSummaryLines.join("\n");
      const summaryHash = createHash("md5").update(summary).digest("hex");
      if (summaryHash !== lastTelegramWatchSummaryHash) {
        lastTelegramWatchSummaryHash = summaryHash;
        console.log("[ConfigSync] Telegram 监听规则摘要:\n" + summary);
      }
    }
  } else {
    console.error("[ConfigSync] Failed to send config update to Telegram Bridge");
  }
}

function hasDiscordListeningAccounts(config: MultiConfig): boolean {
  for (const account of config.accounts) {
    if (isExternalForwardingType(account.forwardingType)) continue;
    const { shouldConnect } = shouldConnectDiscordListener(account);
    if (shouldConnect) return true;
  }
  const libraryAccounts = config.discordAccounts || [];
  if (
    libraryAccounts.some(
      (acc) => acc.loginEnabled !== false && typeof acc.token === "string" && acc.token.trim(),
    )
  ) {
    return true;
  }
  return false;
}

async function ensureDiscordBridgeRunning(config: MultiConfig) {
  if (discordBridgeManager.isRunning()) return true;
  if (!hasDiscordListeningAccounts(config)) {
    return false;
  }
  try {
    console.log("[Main] Starting Discord Bridge...");
    discordBridgeManager.once("started", async () => {
      setupDiscordBridgeClient();
      if (currentConfig) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await syncConfigToDiscordBridge(currentConfig);
          console.log("[Main] Config synced to Discord Bridge, enabled accounts will auto-connect");
        } catch (error: any) {
          console.error(`[Main] Failed to sync config to Discord Bridge: ${error?.message || error}`);
        }
      }
    });

    const bridgeResult = await discordBridgeManager.start();
    if (bridgeResult.success) {
      console.log(`[Main] Discord Bridge started successfully (PID: ${bridgeResult.pid})`);
      return true;
    }
    console.error(`[Main] Failed to start Discord Bridge: ${bridgeResult.message}`);
  } catch (error: any) {
    console.error(`[Main] Error starting Discord Bridge: ${error.message}`);
  }
  return false;
}

async function syncConfigToDiscordBridge(config: MultiConfig) {
  if (!discordBridgeManager.isRunning()) {
    const started = await ensureDiscordBridgeRunning(config);
    if (!started) {
      return;
    }
  }

  if (!discordBridgeClient) {
    setupDiscordBridgeClient();
  }

  const accountsById = new Map<string, DiscordBridgeAccountConfig>();
  for (const account of config.accounts) {
    if (isExternalForwardingType(account.forwardingType)) continue;
    const { shouldConnect, listenChannels } = shouldConnectDiscordListener(account);

    if (account.loginRequested && account.token && listenChannels.size === 0) {
      await writeStatusForAccount(account.id, "idle", "未配置 Discord 监听规则");
    }

    const normalizedToken = normalizeDiscordToken(account.token);
    accountsById.set(account.id, {
      id: account.id,
      token: normalizedToken,
      type: account.type === "bot" ? "bot" : "selfbot",
      enabled: shouldConnect,
      listenChannels: Array.from(listenChannels),
    });
  }

  const libraryAccounts = config.discordAccounts || [];
  try {
    await primeDiscordLibraryStatus(libraryAccounts);
  } catch {}
  for (const account of libraryAccounts) {
    if (account.loginEnabled === false) continue;
    if (typeof account.token !== "string" || !account.token.trim()) continue;
    if (accountsById.has(account.id)) continue;
    const normalizedToken = normalizeDiscordToken(account.token);
    accountsById.set(account.id, {
      id: account.id,
      token: normalizedToken,
      type: account.type === "bot" ? "bot" : "selfbot",
      enabled: true,
      // 使用不可用频道ID占位，保持会话在线但不接收消息
      listenChannels: ["0"],
    });
  }

  const accounts = Array.from(accountsById.values());
  if (discordBridgeClient) {
    try {
      await discordBridgeClient.updateConfig({ accounts });
    } catch (error: any) {
      console.error(`[ConfigSync] Failed to sync config to Discord Bridge: ${error?.message || error}`);
    }
  }
}

/**
 * 获取 Telegram Bridge 客户端
 */
export function getTelegramBridgeClient(): TelegramBridgeClient | null {
  return telegramBridgeClient;
}

main();
