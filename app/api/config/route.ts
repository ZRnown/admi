import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import {
  type AccountConfig,
  getMultiConfig,
  saveMultiConfig,
  type MultiConfig,
  type FeishuTargetConfig,
  type FrontendTelegramConfig,
  type RuleLevelConfig,
  type WatermarkConfig,
} from "@/src/config";
import { readStatus, triggerFile } from "../_lib/common";
import { requireAuth } from "@/app/api/_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");

const MASKED_SECRET = "********";

type TelegramStatusEntry = {
  state?: string;
  message?: string;
  userInfo?: any;
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

async function readTelegramStatus(): Promise<Record<string, TelegramStatusEntry>> {
  try {
    const content = await fs.readFile(telegramStatusFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function resolveTelegramAccountStatuses(
  account: AccountConfig,
  telegramStatus: Record<string, TelegramStatusEntry>,
) {
  const telegramAccounts = account.telegramConfig?.accounts || [];
  const enabledAccounts = telegramAccounts.filter((acc) => acc.enabled === true);

  const botAccount =
    enabledAccounts.find((acc) => acc.type === "bot") ||
    telegramAccounts.find((acc) => acc.type === "bot") ||
    null;
  const clientAccount =
    enabledAccounts.find((acc) => acc.type === "client") ||
    telegramAccounts.find((acc) => acc.type === "client") ||
    null;

  const hasExplicitBot = telegramAccounts.some((acc) => acc.type === "bot");
  const hasLegacyBotConfig = Boolean(account.telegramBotToken);

  // Bot ID: 优先使用显式 bot 账号 ID，否则使用 account.id_bot
  const botAccountId =
    botAccount?.id || (!hasExplicitBot && hasLegacyBotConfig ? `${account.id}_bot` : undefined);

  // Client ID: 更宽松的查找逻辑
  // 1. 优先使用显式 client 账号 ID
  // 2. 否则直接使用 account.id（不再依赖 hasLegacyClientConfig 判断）
  const clientAccountId = clientAccount?.id || account.id;

  // 从状态文件中查找状态
  let botStatus = botAccountId ? telegramStatus[botAccountId] : undefined;
  let clientStatus = telegramStatus[clientAccountId];

  // 如果 clientAccountId 对应的状态看起来像 Bot（username 以 bot 结尾），则不作为 Client 状态
  if (clientStatus?.userInfo?.username?.toLowerCase().endsWith("bot")) {
    // 这可能是 Bot 状态被错误地记录在 account.id 上
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

function normalizeTelegramState(state?: string): string {
  const value = String(state || "").toLowerCase();
  if (value === "connected" || value === "online") return "online";
  if (value === "connecting" || value === "pending") return "pending";
  if (value === "disconnected" || value === "idle") return "idle";
  if (value === "error") return "error";
  return state || "idle";
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
  targetWebhookUrl: string;
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
  blockedKeywords?: string[];
  excludeKeywords?: string[];
  ocrBlockedKeywords?: string[];
  ocrTriggerKeywords?: string[];
  replacementsDictionary?: Record<string, string>;
  // 规则级别的忽略配置
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
  watermark?: WatermarkConfig;
}

interface FrontendAccount {
  id: string;
  name: string;
  type: "bot" | "selfbot";
  forwardingType?: "discord-to-discord" | "discord-to-telegram" | "telegram-to-discord" | "telegram-to-telegram" | "discord-to-feishu";
  token: string;
  proxyUrl: string;
  loginRequested: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  showSourceIdentity: boolean;
  mappings: FrontendMapping[];
  blockedKeywords: string[];
  caseInsensitiveKeywords?: boolean;
  excludeKeywords: string[];
  replacements: { from: string; to: string }[];
  allowedUsersIds: string[];
  mutedUsersIds: string[];
  restartNonce?: number;
  enableTranslation?: boolean;
  translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
  translationApiKey?: string;
  translationSecret?: string;
  deepseekApiKey?: string;
  enableBotRelay?: boolean;
  botRelays?: Array<{ id: string; name: string; token: string; loginState?: string; loginMessage?: string }>;
  channelRelayMap?: Record<string, string>;
  channelFeishuWebhooks?: Record<string, FeishuTargetConfig>;
  enableFeishuForward?: boolean;
  enableDiscordForward?: boolean;
  feishuAppId?: string;
  feishuAppSecret?: string;
  publicBaseUrl?: string;
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
  watermark?: WatermarkConfig;
  // OCR 图片检测相关
  ocrServerUrl?: string;
  ocrBlockedKeywords?: string[];
  ocrTriggerKeywords?: string[];
  // Discord -> Discord 转发样式：style1 = 内嵌（默认），style2 = 纯文本 + 时间
  feishuStyle?: "style1" | "style2";
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
  // Telegram 超长消息处理配置
  enableTelegramOverflow?: boolean; // 是否启用Telegram超长消息处理
  telegramOverflowThreshold?: number; // 全局字数阈值
  telegramOverflowMessage?: string; // 全局超长时附加的消息
  // Telegram 配置（包含 accounts 和 mappings）
  telegramConfig?: FrontendTelegramConfig;
  feishuRuleConfigs?: Record<string, RuleLevelConfig>;
}

interface FrontendPayload {
  accounts: FrontendAccount[];
  activeId?: string;
  loginUser?: string;
  loginPassword?: string;
  telegramAvatarBaseUrl?: string;
  enabledForwardingTypes?: Array<
    "discord-to-discord" | "discord-to-telegram" | "telegram-to-discord" | "telegram-to-telegram" | "discord-to-feishu"
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
    if (!threadId) return null;
    return { mode: "thread", threadId };
  }
  const webhookUrl = typeof raw.webhookUrl === "string" ? raw.webhookUrl.trim() : "";
  if (!webhookUrl) return null;
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
    watermark: raw.watermark && typeof raw.watermark === "object" ? raw.watermark : undefined,
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
      if (acc.enabled === undefined && prev.enabled !== undefined) {
        merged.enabled = prev.enabled;
      }
      mergedAccountMap.set(acc.id, merged);
    } else {
      mergedAccountMap.set(acc.id, { ...acc });
    }
  }

  return {
    ...fallback,
    ...incoming,
    accounts: Array.from(mergedAccountMap.values()),
    mappings: Array.isArray(incoming.mappings) ? incoming.mappings : fallback.mappings,
    enableTelegramForward:
      typeof incoming.enableTelegramForward === "boolean"
        ? incoming.enableTelegramForward
        : fallback.enableTelegramForward,
  };
}

function accountToFrontend(account: AccountConfig): FrontendAccount {
  const mappings: FrontendMapping[] = [];
  const channelTranslate: Record<string, boolean> = (account as any).channelTranslate || {};
  const channelTranslateDirection: Record<string, string> = (account as any).channelTranslateDirection || {};

  // 获取后端保存的详细映射规则列表
  const savedMappings = (account as any).mappings || [];

  // 优先使用 savedMappings 数组（支持相同源ID的多个规则）
  if (savedMappings.length > 0) {
    for (const savedRule of savedMappings) {
      if (!savedRule?.sourceChannelId || !savedRule?.targetWebhookUrl) continue;
      const channelId = String(savedRule.sourceChannelId);
      mappings.push({
        id: savedRule.id || channelId,
        sourceChannelId: channelId,
        targetWebhookUrl: String(savedRule.targetWebhookUrl),
        note: savedRule.note || account.channelNotes?.[channelId],
        translateDirection: !account.enableTranslation
          ? "off"
          : savedRule.translateDirection || (channelTranslateDirection[channelId] as any) || "auto",
        longMessage: savedRule.longMessage || (account as any).channelLongMessage?.[channelId] || { enabled: false },
        allowedUsersIds: (savedRule.allowedUsersIds || []).map(String),
        mutedUsersIds: (savedRule.mutedUsersIds || []).map(String),
        blockedKeywords: savedRule.blockedKeywords || [],
        excludeKeywords: savedRule.excludeKeywords || [],
        ocrBlockedKeywords: savedRule.ocrBlockedKeywords || [],
        ocrTriggerKeywords: savedRule.ocrTriggerKeywords || [],
        replacementsDictionary: savedRule.replacementsDictionary || {},
        // 规则级别的忽略配置
        ignoreSelf: savedRule.ignoreSelf,
        ignoreBot: savedRule.ignoreBot,
        ignoreImages: savedRule.ignoreImages,
        ignoreAudio: savedRule.ignoreAudio,
        ignoreVideo: savedRule.ignoreVideo,
        ignoreDocuments: savedRule.ignoreDocuments,
        ignoreEnglish: savedRule.ignoreEnglish,
        ignoreEnglishThreshold: savedRule.ignoreEnglishThreshold,
        ignoreChinese: savedRule.ignoreChinese,
        ignoreChineseThreshold: savedRule.ignoreChineseThreshold,
        watermark: savedRule.watermark,
      });
    }
  } else {
    // 兼容旧数据：从 channelWebhooks 对象读取
    for (const [channelId, webhookUrl] of Object.entries(account.channelWebhooks || {})) {
      mappings.push({
        id: channelId,
        sourceChannelId: channelId,
        targetWebhookUrl: webhookUrl,
        note: account.channelNotes?.[channelId],
        translateDirection: !account.enableTranslation
          ? "off"
          : (channelTranslateDirection[channelId] as any) || "auto",
        longMessage: (account as any).channelLongMessage?.[channelId] || { enabled: false },
        allowedUsersIds: [],
        mutedUsersIds: [],
        blockedKeywords: [],
        excludeKeywords: [],
        ocrBlockedKeywords: [],
        ocrTriggerKeywords: [],
        replacementsDictionary: {},
        watermark: undefined,
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
    showSourceIdentity: account.showSourceIdentity === true,
    mappings,
    blockedKeywords: account.blockedKeywords || [],
    caseInsensitiveKeywords: account.caseInsensitiveKeywords !== false,
    excludeKeywords: account.excludeKeywords || [],
    replacements,
    allowedUsersIds: (account.allowedUsersIds || []).map((id: any) => String(id)),
    mutedUsersIds: (account.mutedUsersIds || []).map((id: any) => String(id)),
    restartNonce: account.restartNonce,
    enableTranslation: account.enableTranslation === true,
    translationProvider: account.translationProvider || "deepseek",
    translationApiKey: account.translationApiKey || account.deepseekApiKey || "",
    translationSecret: account.translationSecret || "",
    deepseekApiKey: account.deepseekApiKey || "",
    enableBotRelay: account.enableBotRelay === true,
    botRelays: account.botRelays || [],
    channelRelayMap: account.channelRelayMap || {},
    channelFeishuWebhooks: normalizeFeishuTargets(account.channelFeishuWebhooks),
    enableFeishuForward: account.enableFeishuForward === true,
    enableDiscordForward: account.enableDiscordForward !== false,
    feishuAppId: account.feishuAppId || "",
    feishuAppSecret: account.feishuAppSecret || "",
    publicBaseUrl: account.publicBaseUrl || "",
    ignoreSelf: account.ignoreSelf === true,
    ignoreBot: account.ignoreBot === true,
    ignoreImages: account.ignoreImages === true,
    ignoreAudio: account.ignoreAudio === true,
    ignoreVideo: account.ignoreVideo === true,
    ignoreDocuments: account.ignoreDocuments === true,
    ignoreEnglish: account.ignoreEnglish === true,
    ignoreEnglishThreshold: account.ignoreEnglishThreshold,
    ignoreChinese: account.ignoreChinese === true,
    ignoreChineseThreshold: account.ignoreChineseThreshold,
    watermark: account.watermark,
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
  };
}

function maskFrontendAccount(account: FrontendAccount): FrontendAccount {
  const masked: FrontendAccount = { ...account };
  masked.token = maskSecret(account.token);
  masked.translationApiKey = maskSecret(account.translationApiKey);
  masked.translationSecret = maskSecret(account.translationSecret);
  masked.deepseekApiKey = maskSecret(account.deepseekApiKey);
  masked.feishuAppSecret = maskSecret(account.feishuAppSecret);
  masked.telegramBotToken = maskSecret(account.telegramBotToken);
  masked.telegramApiHash = maskSecret(account.telegramApiHash);
  masked.telegramSessionString = maskSecret(account.telegramSessionString);

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
      })),
    };
  }

  return masked;
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

  if (Array.isArray(dto.mappings)) {
    for (const mapping of dto.mappings) {
      if (mapping?.sourceChannelId && mapping?.targetWebhookUrl) {
        const key = String(mapping.sourceChannelId);
        channelWebhooks[key] = String(mapping.targetWebhookUrl);
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
      savedMappings.push({
        id: mapping.id || randomUUID(),
        sourceChannelId: key,
        targetWebhookUrl: String(mapping.targetWebhookUrl),
          note: mapping.note,
          translateDirection: mapping.translateDirection,
          longMessage: mapping.longMessage,
          allowedUsersIds: mapping.allowedUsersIds || [],
          mutedUsersIds: mapping.mutedUsersIds || [],
          blockedKeywords: mapping.blockedKeywords || [],
          excludeKeywords: mapping.excludeKeywords || [],
          ocrBlockedKeywords: mapping.ocrBlockedKeywords || [],
          ocrTriggerKeywords: mapping.ocrTriggerKeywords || [],
          replacementsDictionary: mapping.replacementsDictionary || {},
          // 规则级别的忽略配置
          ignoreSelf: mapping.ignoreSelf,
          ignoreBot: mapping.ignoreBot,
          ignoreImages: mapping.ignoreImages,
          ignoreAudio: mapping.ignoreAudio,
          ignoreVideo: mapping.ignoreVideo,
          ignoreDocuments: mapping.ignoreDocuments,
          ignoreEnglish: mapping.ignoreEnglish,
          ignoreEnglishThreshold: mapping.ignoreEnglishThreshold,
          ignoreChinese: mapping.ignoreChinese,
          ignoreChineseThreshold: mapping.ignoreChineseThreshold,
          watermark: mapping.watermark,
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

  let loginRequested: boolean;
  if (fallback && fallback.loginRequested === true) {
    loginRequested = dto.loginRequested === false ? false : true;
  } else {
    loginRequested = dto.loginRequested === true;
  }

  return {
    ...base,
    id: dto.id || base.id,
    name: dto.name || base.name,
    type: dto.type === "bot" ? "bot" : "selfbot",
    forwardingType: dto.forwardingType || base.forwardingType || "discord-to-discord",
    token: resolveSecretValue(dto.token, base.token) || "",
    proxyUrl: dto.proxyUrl || "",
    loginRequested,
    loginNonce: dto.loginNonce ?? base.loginNonce,
    showSourceIdentity: dto.showSourceIdentity === true,
    channelWebhooks,
    mappings: savedMappings,
    channelFeishuWebhooks,
    feishuRuleConfigs,
    enableFeishuForward: dto.enableFeishuForward === true,
    enableDiscordForward: dto.enableDiscordForward !== false,
    feishuAppId: typeof dto.feishuAppId === "string" && dto.feishuAppId.trim() ? dto.feishuAppId.trim() : base.feishuAppId,
    feishuAppSecret:
      typeof resolveSecretValue(dto.feishuAppSecret, base.feishuAppSecret) === "string" &&
      resolveSecretValue(dto.feishuAppSecret, base.feishuAppSecret)!.trim()
        ? resolveSecretValue(dto.feishuAppSecret, base.feishuAppSecret)!.trim()
        : base.feishuAppSecret,
    publicBaseUrl:
      typeof dto.publicBaseUrl === "string" && dto.publicBaseUrl.trim()
        ? dto.publicBaseUrl.trim()
        : base.publicBaseUrl,
    channelNotes,
    channelTranslate,
    channelTranslateDirection,
    channelLongMessage,
    blockedKeywords: Array.isArray(dto.blockedKeywords) ? dto.blockedKeywords : [],
    caseInsensitiveKeywords:
      typeof dto.caseInsensitiveKeywords === "boolean"
        ? dto.caseInsensitiveKeywords
        : base.caseInsensitiveKeywords ?? true,
    excludeKeywords: Array.isArray(dto.excludeKeywords) ? dto.excludeKeywords : [],
    replacementsDictionary,
    allowedUsersIds: Array.isArray(dto.allowedUsersIds) ? dto.allowedUsersIds : base.allowedUsersIds || [],
    mutedUsersIds: Array.isArray(dto.mutedUsersIds) ? dto.mutedUsersIds : base.mutedUsersIds || [],
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
    watermark: dto.watermark && typeof dto.watermark === "object" ? dto.watermark : base.watermark,
    ocrServerUrl: typeof dto.ocrServerUrl === "string" && dto.ocrServerUrl.trim() ? dto.ocrServerUrl.trim() : "http://localhost:9003",
    ocrBlockedKeywords: Array.isArray(dto.ocrBlockedKeywords) ? dto.ocrBlockedKeywords : [],
    ocrTriggerKeywords: Array.isArray(dto.ocrTriggerKeywords) ? dto.ocrTriggerKeywords : [],
    feishuStyle: dto.feishuStyle === "style1" || dto.feishuStyle === "style2" ? dto.feishuStyle : (base.feishuStyle || "style1"),
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
  };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(req);
    if (auth) return auth;

    const includeSecrets =
      req.nextUrl.searchParams.get("includeSecrets") === "1" ||
      req.nextUrl.searchParams.get("export") === "1";
    const multi = await getMultiConfig();
    const status = await readStatus();
    const telegramStatus = await readTelegramStatus();
    const payload: FrontendPayload = {
      accounts: multi.accounts.map((acc) => {
        const { botStatus, clientStatus } = resolveTelegramAccountStatuses(acc, telegramStatus);
        const botState = normalizeTelegramState(botStatus?.state);
        const clientState = normalizeTelegramState(clientStatus?.state);
        const frontend = {
          ...accountToFrontend(acc),
          ...(status[acc.id] || {}),
          telegramBotState: botState,
          telegramBotMessage: normalizeTelegramMessage(botState, botStatus?.message),
          telegramClientState: clientState,
          telegramClientMessage: normalizeTelegramMessage(clientState, clientStatus?.message),
        };
        return includeSecrets ? frontend : maskFrontendAccount(frontend);
      }),
      activeId: multi.activeId || multi.accounts[0]?.id || "",
      loginUser: multi.loginUser || "",
      loginPassword: includeSecrets ? multi.loginPassword || "" : maskSecret(multi.loginPassword),
      telegramAvatarBaseUrl: multi.telegramAvatarBaseUrl || "",
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
      next = {
        accounts,
        activeId,
        loginUser: typeof body.loginUser === "string" ? body.loginUser : current.loginUser,
        loginPassword: typeof resolvedLoginPassword === "string" ? resolvedLoginPassword : current.loginPassword,
        telegramAvatarBaseUrl:
          typeof body.telegramAvatarBaseUrl === "string" && body.telegramAvatarBaseUrl.trim()
            ? body.telegramAvatarBaseUrl.trim()
            : current.telegramAvatarBaseUrl,
      };
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
      next = { accounts: [account], activeId: id };
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

    const next: MultiConfig = {
      accounts,
      activeId,
      loginUser: typeof body.loginUser === "string" ? body.loginUser : current.loginUser,
      loginPassword: typeof resolvedLoginPassword === "string" ? resolvedLoginPassword : current.loginPassword,
      telegramAvatarBaseUrl:
        typeof body.telegramAvatarBaseUrl === "string" && body.telegramAvatarBaseUrl.trim()
          ? body.telegramAvatarBaseUrl.trim()
          : current.telegramAvatarBaseUrl,
    };

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
