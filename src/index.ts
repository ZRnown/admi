import { Client as SelfBotClient } from "discord.js-selfbot-v13";
import { Client as BotClient, GatewayIntentBits, Partials } from "discord.js";
import { promises as fs } from "fs";
import { watch, stat } from "node:fs";
import path from "node:path";
import { createHash } from "crypto";

import { Bot, Client } from "./bot.js";
import { OCRClient } from "./ocrClient.js";
import {
  getMultiConfig,
  type MultiConfig,
  type AccountConfig,
  type RuleLevelConfig,
  type ScheduledContentItem,
  accountToLegacyConfig,
  ensureConfigFile,
  getConfigPath,
} from "./config.js";
import { getEnv } from "./env.js";
import { SenderBot } from "./senderBot.js";
import { FeishuSender } from "./feishuSender.js";
import { ProxyAgent } from "proxy-agent";
import { FileLogger } from "./logger.js";
import { telegramBridgeManager } from "./processManager.js";
import { TelegramBridgeClient } from "./telegramBridgeClient.js";
import { formatKeywordGroups, matchParsedKeywordGroups, parseKeywordGroups } from "./keywordMatcher.js";
import { clampPercent, getLanguageRatio, stripLanguages } from "./languageFilter.js";
import { resolveWatermarkList } from "./watermark.js";

// 全局 Telegram Bridge 客户端
let telegramBridgeClient: TelegramBridgeClient | null = null;

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
const ocrClients = new Map<string, { url: string; client: OCRClient }>();
const translationSenders = new Map<string, { key: string; sender: SenderBot }>();
const telegramReplyMap = new Map<string, string>();
const telegramReplyQueue: string[] = [];
const TELEGRAM_REPLY_CACHE_LIMIT = 10000;
// 记录已经输出过"未配置 token"错误的账号，避免重复日志
const loggedNoTokenAccounts = new Set<string>();
// 记录配置文件的 hash，只在真正变化时才重新读取
let lastConfigHash: string | null = null;
let lastConfigMtime: number = 0;

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

function stripEmbedText(
  embeds: any[] | undefined,
  options: { stripEnglish?: boolean; stripChinese?: boolean },
): any[] | undefined {
  if (!embeds || embeds.length === 0) return embeds;
  if (!options.stripEnglish && !options.stripChinese) return embeds;
  const sanitizeText = (value: unknown) =>
    typeof value === "string" ? stripLanguages(value, options) : value;
  return embeds.map((embed) => {
    if (!embed || typeof embed !== "object") return embed;
    let raw: any = embed;
    if (typeof (embed as any).toJSON === "function") {
      try {
        raw = (embed as any).toJSON();
      } catch {}
    } else if ("data" in embed && (embed as any).data) {
      raw = (embed as any).data;
    }
    if (!raw || typeof raw !== "object") return raw;
    const next: any = { ...raw };
    if (typeof next.title === "string") next.title = sanitizeText(next.title);
    if (typeof next.description === "string") next.description = sanitizeText(next.description);
    if (next.footer && typeof next.footer === "object") {
      next.footer = { ...next.footer };
      if (typeof next.footer.text === "string") next.footer.text = sanitizeText(next.footer.text);
    }
    if (next.author && typeof next.author === "object") {
      next.author = { ...next.author };
      if (typeof next.author.name === "string") next.author.name = sanitizeText(next.author.name);
    }
    if (Array.isArray(next.fields)) {
      next.fields = next.fields.map((field: any) => {
        if (!field || typeof field !== "object") return field;
        const copy = { ...field };
        if (typeof copy.name === "string") copy.name = sanitizeText(copy.name);
        if (typeof copy.value === "string") copy.value = sanitizeText(copy.value);
        return copy;
      });
    }
    return next;
  });
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
  const senderAccount = selectTelegramSendAccount(account, target.preferredSenderType, "sender");
  if (!senderAccount) {
    throw new Error("未找到可用 Telegram 发送账号");
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
  await bridge.sendMessage({
    accountId: senderAccount.id,
    accountType: senderAccount.type,
    chatId: sendChatId,
    message: {
      text: content,
      watermark: effectiveWatermarks[0],
      watermarkSecondary: effectiveWatermarks[1],
      watermarks: effectiveWatermarks,
    },
    media: uploads.length > 0 ? uploads : undefined,
  });
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

async function writeStatus(accountId: string, state: string, message?: string) {
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

function buildDiscordShareKey(account: AccountConfig): string | null {
  if (!account.token) return null;
  return `${account.type}:${account.token}`;
}

function getSharedClientByAccountId(accountId: string) {
  const running = runningAccounts.get(accountId);
  if (!running?.sharedKey) return null;
  return sharedDiscordClients.get(running.sharedKey) || null;
}

async function writeStatusForAccount(accountId: string, state: string, message?: string) {
  const shared = getSharedClientByAccountId(accountId);
  if (shared) {
    await Promise.all(
      Array.from(shared.accountIds).map((id) => writeStatus(id, state, message)),
    );
    return;
  }
  await writeStatus(accountId, state, message);
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

  if (telegramBridgeClient) {
    telegramBridgeClient.destroy();
  }

  telegramBridgeClient = new TelegramBridgeClient(bridgeProcess);
  console.log("[Main] Telegram Bridge IPC client initialized");
  const telegramForwardLogger = new FileLogger();

  telegramBridgeClient.on("telegram_message", async (params) => {
    const accounts = currentConfig?.accounts || [];
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
          if (sourceChatId && raw === sourceChatId) return true;
          if (sourceChatUsername) {
            const normalized = raw.startsWith("@") ? raw.slice(1) : raw;
            return normalized === sourceChatUsername;
          }
          return false;
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
      const caseInsensitive = account.caseInsensitiveKeywords ?? true;
      const hasRuleOcrFilters = matchingRules.some(
        (rule: any) =>
          parseKeywordGroups(rule.ocrBlockedKeywords).length > 0 ||
          parseKeywordGroups(rule.ocrTriggerKeywords).length > 0,
      );
      let englishRatio: number | null = null;
      let chineseRatio: number | null = null;

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

      for (const rule of filteredRules) {
        const senderDisplayName =
          params.from_display_name ||
          params.from_username ||
          "Telegram User";
        const stripEnglish = account.stripEnglish === true || rule.stripEnglish === true;
        const stripChinese = account.stripChinese === true || rule.stripChinese === true;
        const stripOptions = { stripEnglish, stripChinese };
        try {
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
            useEmbed = forwardStyle === "style1";

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
                useEmbed = false;
                const replyTitle = forwardStyle === "style3" ? "💬 回复" : `💬 回复 ${replyName}`;
                extraEmbeds = [
                  {
                    color: 0x0000ff,
                    description: `**${replyTitle}**\n${replyContent}`,
                    footer: { text: `⏰ ${formatTimestampFromSeconds(params.date)}` }
                  }
                ];
              }
            }
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

          if (isTelegramToTelegram) {
            const targetChatId = typeof rule.targetChannelId === "string" ? rule.targetChannelId.trim() : "";
            if (!targetChatId) {
              logSkip("未配置目标 Chat ID", `目标: ${rule.targetChannelId || "空"}`);
              continue;
            }
            const sendChatId = normalizeTelegramChatId(targetChatId);

            const preferredSenderType = account.telegramConfig?.defaultSenderAccountType;
            const senderAccount = selectTelegramSendAccount(account, preferredSenderType, "sender");
            if (!senderAccount) {
              logSkip("未找到可用 Telegram 发送账号", `目标: ${targetChatId}`);
              continue;
            }

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

            const bridge = telegramBridgeClient;
            if (!bridge) {
              logSkip("Telegram Bridge 未就绪", `目标: ${targetChatId}`);
              continue;
            }

            const sendResult = await bridge.sendMessage({
              accountId: senderAccount.id,
              accountType: senderAccount.type,
              chatId: sendChatId,
              message: {
                text: telegramContent,
                reply_to_message_id: replyTargetId,
                watermark: effectiveWatermarks[0],
                watermarkSecondary: effectiveWatermarks[1],
                watermarks: effectiveWatermarks,
              },
              media: uploads.length > 0 ? uploads : undefined,
            });

            if (sendResult?.messageId && sourceChatId && sourceMessageId) {
              recordTelegramReplyMapping(sourceChatId, String(sourceMessageId), targetChatId, String(sendResult.messageId));
            }

            if (sendResult?.success || sendResult?.messageId) {
              const logMsg =
                `[${forwardTag}] 转发成功 | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
                `目标: ${targetChatId} | 内容: ${contentPreview} | 附件: ${uploads.length}`;
              console.log(logMsg);
              telegramForwardLogger.info(logMsg);
            } else {
              const errorMsg =
                `[${forwardTag}] 转发失败 | 账号: ${account.name} | 来自: ${senderLabel} | 源: ${sourceLabel} | ` +
                `目标: ${targetChatId} | 错误: ${String(sendResult?.error || sendResult?.message || "未知错误")}`;
              console.error(errorMsg);
              telegramForwardLogger.error(errorMsg);
            }
          } else {
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

async function startAccount(account: AccountConfig, logger: FileLogger) {
  if (!account.loginRequested) {
    await writeStatusForAccount(account.id, "idle", "未请求登录");
    return;
  }

  // 立即设置 pending 状态，表示正在登录
  await writeStatusForAccount(account.id, "pending", "正在登录...");

  if (!account.token) {
    // 这个错误应该在 reconcileAccounts 中已经处理过了，这里只更新状态
    if (!loggedNoTokenAccounts.has(account.id)) {
      await logger.error(`账号 "${account.name}" 未配置 token，已跳过登录`);
      loggedNoTokenAccounts.add(account.id);
    }
    await writeStatusForAccount(account.id, "error", "未配置 Token");
    return;
  }

  // 检查是否有配置转发规则（Discord、飞书或 Telegram 至少一个）
  const webhooks = account.enableDiscordForward !== false ? (account.channelWebhooks || {}) : {};
  const feishuWebhooks = account.enableFeishuForward ? (account.channelFeishuWebhooks || {}) : {};
  const telegramMappings = account.telegramConfig?.mappings || [];
  const hasTelegramForward = telegramMappings.length > 0 && account.telegramConfig?.enableTelegramForward !== false;

  if (Object.keys(webhooks).length === 0 && Object.keys(feishuWebhooks).length === 0 && !hasTelegramForward) {
    await logger.error(`账号 "${account.name}" 未配置任何转发规则（Discord、飞书或 Telegram），无法启动`);
    await writeStatusForAccount(account.id, "error", "未配置转发规则");
    return;
  }

  // 首先检查是否已经存在运行中的账号
  const existing = runningAccounts.get(account.id);
  if (existing) {
    const isAlreadyLoggedIn = existing.client && (existing.client as any).user;
    const isLoggingIn =
      existing.isLoggingIn ||
      (existing.client && (existing.client as any).ws && (existing.client as any).ws.readyState === 0);
    
    // 如果账号已经登录或正在登录中，只更新配置，不重新创建
    if (isAlreadyLoggedIn || isLoggingIn) {
      await logger.info(`账号 "${account.name}" 已经运行${isAlreadyLoggedIn ? "且已登录" : "且正在登录中"}，跳过重复启动，仅更新配置`);
      
      // 更新配置
      const { senderBotsBySource, defaultSenderBot, feishuSendersBySource } = await buildSenderBots(account, logger);
      const legacyConfig = accountToLegacyConfig(account);
      existing.account = account;
      existing.senderBotsBySource = senderBotsBySource;
      (existing as any).feishuSendersBySource = feishuSendersBySource;
      existing.defaultSenderBot = defaultSenderBot;
      existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);
      refreshScheduledBroadcasts(account, existing, logger);
      
      if (isAlreadyLoggedIn) {
        await writeStatusForAccount(
          account.id,
          "online",
          buildDiscordLoginMessage((existing.client as any)?.user, "登录成功"),
        );
      }
      return;
    }
    
    // 如果账号存在但没有登录，先停止它
    await logger.info(`账号 "${account.name}" 存在但未登录，先停止旧实例`);
    await stopAccount(account.id, logger, false);
  }

  const shareKey = buildDiscordShareKey(account);
  const sharedClientEntry = shareKey ? sharedDiscordClients.get(shareKey) : null;
  if (sharedClientEntry) {
    const { senderBotsBySource, defaultSenderBot, feishuSendersBySource } = await buildSenderBots(account, logger);
    const legacyConfig = accountToLegacyConfig(account);
    const bot = new Bot(
      sharedClientEntry.client,
      legacyConfig,
      defaultSenderBot,
      senderBotsBySource,
      feishuSendersBySource,
      { sharedClient: true },
    );
    sharedClientEntry.accountIds.add(account.id);
    const runningInfo: RunningAccount = {
      account,
      client: sharedClientEntry.client,
      bot,
      senderBotsBySource,
      defaultSenderBot,
      feishuSendersBySource,
      isManuallyStopped: false,
      reconnectCount: 0,
      lastReconnectTime: 0,
      isLoggingIn: false,
      sharedKey: shareKey || undefined,
      sharedPrimary: false,
    };
    runningAccounts.set(account.id, runningInfo);
    refreshScheduledBroadcasts(account, runningInfo, logger);

    if ((sharedClientEntry.client as any)?.user) {
      await writeStatusForAccount(account.id, "online", buildDiscordLoginMessage((sharedClientEntry.client as any)?.user, "登录成功"));
    } else {
      await writeStatusForAccount(account.id, "pending", "共享账号登录中...");
    }
    return;
  }

  try {
    const { senderBotsBySource, defaultSenderBot, feishuSendersBySource } = await buildSenderBots(account, logger);
    const legacyConfig = accountToLegacyConfig(account);

    let client: Client;
    if (account.type === "bot") {
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
      // User Token (Selfbot) 配置
      // 注意：User Token 需要缓存自身信息和一定的上下文才能完成握手
      // 不能将 UserManager 或 GuildMemberManager 设为 0，否则无法触发 ready 事件
      try {
        // 使用宽松的配置，确保 Selfbot 能正常登录
        client = new SelfBotClient({
          checkUpdate: false,  // 禁用检查更新，加快启动
          patchVoice: false,   // 如果不用语音，禁用此项
          syncStatus: false,   // 不同步状态，减少数据包
          // 注意：暂时移除 makeCache 配置，因为过度限制会导致无法登录
          // 如果确实需要限制内存，可以稍后使用更宽松的配置
        } as any);
      } catch (e) {
        // 如果配置失败，使用最简配置
        client = new SelfBotClient({
          checkUpdate: false,
          patchVoice: false,
        } as any);
        logger.warn(`无法应用 Selfbot 配置，使用默认配置: ${String(e)}`);
      }
    }

    const bot = new Bot(client, legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);

    if (shareKey) {
      let entry = sharedDiscordClients.get(shareKey);
      if (!entry) {
        entry = {
          key: shareKey,
          token: account.token,
          type: account.type,
          client,
          accountIds: new Set(),
        };
        sharedDiscordClients.set(shareKey, entry);
      } else {
        entry.client = client;
      }
      entry.accountIds.add(account.id);
    }

    const runningInfo: RunningAccount = {
      account,
      client,
      bot,
      senderBotsBySource,
      defaultSenderBot,
      feishuSendersBySource,
      isManuallyStopped: false,
      reconnectCount: 0,
      lastReconnectTime: 0,
      isLoggingIn: true,
      sharedKey: shareKey || undefined,
      sharedPrimary: Boolean(shareKey),
    };
    runningAccounts.set(account.id, runningInfo);
    refreshScheduledBroadcasts(account, runningInfo, logger);

    // 添加调试日志，查看底层 WebSocket 状态（仅对 User Token）
    if (account.type === "selfbot") {
      (client as any).on("debug", (info: string) => {
        // 过滤掉心跳包日志，只看关键信息
        if (!info.includes("Heartbeat") && !info.includes("heartbeat")) {
          logger.debug(`[DEBUG ${account.name}] ${info}`);
        }
      });
    }

    // 在 ready 事件中注册重连处理器，避免登录过程中的临时断开事件触发重连
    // 先注册 ready 事件，在 ready 后再注册 disconnect 监听器
    // 同时监听 ready 和 clientReady 以兼容不同版本
    let readyHandled = false; // 防止重复处理
    const readyHandler = async () => {
      // 如果已经处理过，跳过
      if (readyHandled) {
        return;
      }
      
      const currentRunning = runningAccounts.get(account.id);
      if (currentRunning && currentRunning.isLoggingIn) {
        readyHandled = true;
        // 登录成功后，清除登录标志
        currentRunning.isLoggingIn = false;
        // 清除登录超时定时器
        if (currentRunning.loginTimeout) {
          clearTimeout(currentRunning.loginTimeout);
          currentRunning.loginTimeout = undefined;
        }
        // 现在才注册重连处理器，避免登录过程中的临时断开事件
        setupReconnectHandlers(account.id, logger);
        await writeStatusForAccount(
          account.id,
          "online",
          buildDiscordLoginMessage((bot.client as any)?.user, "登录成功"),
        );
        await logger.info(`账号 "${account.name}" 登录成功（通过 ready 事件），已注册重连处理器`);
      }
    };
    (bot.client as any).once("clientReady", readyHandler);
    (bot.client as any).once("ready", readyHandler);

    // 设置登录超时检查（30秒）
    runningInfo.loginTimeout = setTimeout(() => {
      const currentRunning = runningAccounts.get(account.id);
      if (currentRunning && currentRunning.isLoggingIn) {
        logger.warn(`账号 "${account.name}" 登录超时 (30秒)，可能是网络问题或账号被风控`);
        writeStatusForAccount(account.id, "error", "登录超时，可能是网络问题或需要登录").catch(() => {});
      }
    }, 30000);

    try {
      await logger.info(`账号 "${account.name}" 开始登录...`);
      await (bot.client as any).login(account.token);
      
      // 登录调用完成后，检查是否已经登录成功（ready 事件可能已经触发）
      // 等待一小段时间让 ready 事件有机会触发
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 检查 client.user 是否存在，如果存在说明已经登录成功
      const client = bot.client as any;
      if (client.user && client.ws && client.ws.readyState === 1) {
        // 已经登录成功，直接更新状态
        const currentRunning = runningAccounts.get(account.id);
        if (currentRunning && currentRunning.isLoggingIn) {
          currentRunning.isLoggingIn = false;
          if (currentRunning.loginTimeout) {
            clearTimeout(currentRunning.loginTimeout);
            currentRunning.loginTimeout = undefined;
          }
          setupReconnectHandlers(account.id, logger);
          await writeStatusForAccount(
            account.id,
            "online",
            buildDiscordLoginMessage((bot.client as any)?.user, "登录成功"),
          );
          await logger.info(`账号 "${account.name}" 登录成功（通过状态检查），已注册重连处理器`);
          // 标记 ready 已处理，防止 readyHandler 重复处理
          readyHandled = true;
        }
      }
      // 注意：如果 ready 事件稍后触发，readyHandler 会检查 readyHandled 标志，不会重复操作
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.error(e);
      await logger.error(`账号 "${account.name}" 登录失败: ${msg}`);
      const isTokenInvalid = msg.includes("TOKEN_INVALID") || 
                            msg.includes("TokenInvalid") || 
                            msg.includes("Token 无效") ||
                            (e?.code === "TokenInvalid");
      
      await writeStatusForAccount(account.id, "error", isTokenInvalid ? "Token 无效" : msg);
      runningInfo.isLoggingIn = false;
      // 清除登录超时定时器
      if (runningInfo.loginTimeout) {
        clearTimeout(runningInfo.loginTimeout);
        runningInfo.loginTimeout = undefined;
      }
      // 如果不是 Token 无效的错误，尝试重连
      if (!isTokenInvalid) {
        await reconnectAccount(account.id, logger, 5000);
      } else {
        await logger.error(`账号 "${account.name}" Token 无效，停止登录`);
        await stopAccount(account.id, logger, false);
      }
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
  
  const sharedKey = running.sharedKey;
  const sharedEntry = sharedKey ? sharedDiscordClients.get(sharedKey) : null;

  try {
    // 清理 Bot 资源（包括定时器等）
    if (running.bot && typeof (running.bot as any).cleanup === "function") {
      await (running.bot as any).cleanup();
    }
    if (sharedEntry) {
      sharedEntry.accountIds.delete(accountId);
      if (sharedEntry.accountIds.size === 0) {
        if ((running.client as any).destroy) {
          await (running.client as any).destroy();
        }
        sharedDiscordClients.delete(sharedKey as string);
      } else {
        const nextPrimaryId = Array.from(sharedEntry.accountIds)[0];
        const nextRunning = runningAccounts.get(nextPrimaryId);
        if (nextRunning) {
          nextRunning.sharedPrimary = true;
          setupReconnectHandlers(nextPrimaryId, logger);
        }
      }
    } else if ((running.client as any).destroy) {
      await (running.client as any).destroy();
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
      try {
        if ((currentRunning.client as any).destroy) {
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
        // User Token (Selfbot) 配置 - 重连时使用相同配置
        try {
          client = new SelfBotClient({
            checkUpdate: false,
            patchVoice: false,
            syncStatus: false,  // 不同步状态，减少数据包
            // 注意：暂时移除 makeCache 配置，确保能正常登录
          } as any);
        } catch (e) {
          client = new SelfBotClient({
            checkUpdate: false,
            patchVoice: false,
          } as any);
        }
      }
      
      // 重新创建 Bot 实例
      const legacyConfig = accountToLegacyConfig(currentRunning.account);
      const bot = new Bot(client, legacyConfig, currentRunning.defaultSenderBot, currentRunning.senderBotsBySource);
      
      // 更新运行信息
      currentRunning.client = client;
      currentRunning.bot = bot;
      currentRunning.isLoggingIn = true;
      
      // 添加调试日志（仅对 User Token）
      if (currentRunning.account.type === "selfbot") {
        (client as any).on("debug", (info: string) => {
          if (!info.includes("Heartbeat") && !info.includes("heartbeat")) {
            logger.debug(`[DEBUG ${currentRunning.account.name}] ${info}`);
          }
        });
      }

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
      await startAccount(account, logger);
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
        if (ruleConfigChanged || scheduledChanged || forwardingTypeChanged) {
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
      await startAccount(account, logger);
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

  currentConfig = newConfig;
}

async function main() {
  const logger = new FileLogger();

  // 在启动时先确保文件存在。这是唯一一次允许创建默认文件的机会。
  // 之后的热重载只负责读取，不会创建文件，避免在原子保存间隙时覆盖配置
  await ensureConfigFile();

  const multi = await getMultiConfig();
  currentConfig = multi;

  // 启动时自动连接所有已配置 loginRequested=true 的账号
  await logger.info("系统启动，将自动连接所有已配置的账号...");

  // 只启动已请求登录的账号，不自动登录
  for (const account of multi.accounts) {
    if (account.loginRequested && account.token) {
      await startAccount(account, logger);
    } else {
      // 确保未请求登录的账号状态正确
      await writeStatus(account.id, "idle", "未请求登录");
    }
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
          await reconcileAccounts(latest, logger);
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
  await telegramBridgeManager.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[Main] Received SIGTERM, shutting down...");
  await telegramBridgeManager.cleanup();
  process.exit(0);
});

/**
 * 同步配置到Telegram Bridge进程
 */
async function syncConfigToTelegramBridge(config: MultiConfig) {
  // 检查Telegram Bridge是否在运行
  if (!telegramBridgeManager.isRunning()) {
    console.log("[ConfigSync] Telegram Bridge not running, skipping config sync");
    return;
  }

  // 提取Telegram相关配置
  const telegramAccounts: any[] = [];
  const telegramAccountIds = new Set<string>();
  const pushTelegramAccount = (tgAccount: any) => {
    if (!tgAccount || !tgAccount.id) return;
    if (telegramAccountIds.has(tgAccount.id)) return;
    telegramAccounts.push(tgAccount);
    telegramAccountIds.add(tgAccount.id);
  };
  const telegramMappings = [];

  for (const account of config.accounts) {
    if (account.telegramConfig) {
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
          pushTelegramAccount({
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
            enabled: tgAccount.enabled !== false
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
        pushTelegramAccount({
          id: botStatusId,
          name: `${account.name || "Telegram"} Bot`,
          type: "bot",
          token: account.telegramBotToken,
          sessionType: account.sessionType,
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          proxyUrl: account.proxyUrl,
          // 优先使用已保存的 enabled 状态，否则默认 false
          enabled: existingBotEntry ? existingBotEntry.enabled !== false : false,
        });
      }

      // 如果有 legacy client 配置（session）且没有显式的 client 账号，创建一个 client 账号
      if (!hasExplicitClient && hasLegacyClientConfig) {
        // 检查是否有对应的 client 状态条目（用户可能手动断开过）
        const existingClientEntry = (account.telegramConfig.accounts || []).find(
          (tgAccount) => tgAccount.id === account.id
        );
        pushTelegramAccount({
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
          enabled: existingClientEntry ? existingClientEntry.enabled !== false : false,
        });
      }

      // 添加Telegram映射，并附带 Discord 账号的 showSourceIdentity 设置
      if (account.telegramConfig.mappings) {
        for (const mapping of account.telegramConfig.mappings) {
          telegramMappings.push({
            ...mapping,
            showSourceIdentity: account.showSourceIdentity === true,
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
      accounts: telegramAccounts,
      mappings: telegramMappings
    }
  };

  const messageSent = telegramBridgeManager.sendMessage(JSON.stringify(configUpdateMessage));
  if (messageSent) {
    console.log(`[ConfigSync] Configuration synced to Telegram Bridge (${telegramAccounts.length} accounts, ${telegramMappings.length} mappings)`);
  } else {
    console.error("[ConfigSync] Failed to send config update to Telegram Bridge");
  }
}

/**
 * 获取 Telegram Bridge 客户端
 */
export function getTelegramBridgeClient(): TelegramBridgeClient | null {
  return telegramBridgeClient;
}

main();
