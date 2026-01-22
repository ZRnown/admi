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
} from "@/src/config";
import { readStatus, triggerFile } from "../_lib/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");

type TelegramStatusEntry = {
  state?: string;
  message?: string;
  userInfo?: any;
};

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
  const enabledAccounts = telegramAccounts.filter((acc) => acc.enabled !== false);

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

interface FrontendMapping {
  id: string;
  sourceChannelId: string;
  targetWebhookUrl: string;
  note?: string;
  // 是否开启翻译
  translate?: boolean;
  // 翻译方向: off = 关闭翻译, auto = 自动检测, zh-en = 中译英, en-zh = 英译中
  translateDirection?: "off" | "auto" | "zh-en" | "en-zh";
  // Telegram 超长消息处理（仅对目标为Telegram的规则有效）
  longMessage?: {
    enabled: boolean;
    threshold?: number;
    appendMessage?: string;
  };
}

interface FrontendAccount {
  id: string;
  name: string;
  type: "bot" | "selfbot";
  forwardingType?: "discord-to-discord" | "discord-to-telegram" | "telegram-to-discord" | "discord-to-feishu";
  token: string;
  proxyUrl: string;
  loginRequested: boolean;
  loginNonce?: number;
  loginState?: string;
  loginMessage?: string;
  showSourceIdentity: boolean;
  mappings: FrontendMapping[];
  blockedKeywords: string[];
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
  // OCR 图片检测相关
  ocrServerUrl?: string;
  ocrBlockedKeywords?: string[];
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
}

interface FrontendPayload {
  accounts: FrontendAccount[];
  activeId?: string;
  loginUser?: string;
  loginPassword?: string;
  telegramAvatarBaseUrl?: string;
  enabledForwardingTypes?: Array<"discord-to-discord" | "discord-to-telegram" | "telegram-to-discord" | "discord-to-feishu">;
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

function accountToFrontend(account: AccountConfig): FrontendAccount {
  const mappings: FrontendMapping[] = [];
  const channelTranslate: Record<string, boolean> = (account as any).channelTranslate || {};
  const channelTranslateDirection: Record<string, string> = (account as any).channelTranslateDirection || {};
  for (const [channelId, webhookUrl] of Object.entries(account.channelWebhooks || {})) {
    mappings.push({
      id: channelId,
      sourceChannelId: channelId,
      targetWebhookUrl: webhookUrl,
      note: account.channelNotes?.[channelId],
      // UI 行为：如果全局翻译关闭，则默认为"off"；否则如果没有单独配置，则为"auto"
      translateDirection: !account.enableTranslation 
        ? "off"
        : (channelTranslateDirection[channelId] as any) || "auto",
      // Telegram 超长消息处理
      longMessage: (account as any).channelLongMessage?.[channelId] || { enabled: false },
    });
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
    ocrServerUrl: account.ocrServerUrl || "http://localhost:9003",
    ocrBlockedKeywords: account.ocrBlockedKeywords || [],
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
      feishuStyle: "style1",
    } as AccountConfig);

  const channelWebhooks: Record<string, string> = {};
  const channelNotes: Record<string, string> = {};
  const channelTranslate: Record<string, boolean> = {};
  const channelTranslateDirection: Record<string, "off" | "auto" | "zh-en" | "en-zh"> = {};
  const channelLongMessage: Record<string, { enabled: boolean; threshold?: number; appendMessage?: string }> = {};
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
    token: dto.token || "",
    proxyUrl: dto.proxyUrl || "",
    loginRequested,
    loginNonce: dto.loginNonce ?? base.loginNonce,
    showSourceIdentity: dto.showSourceIdentity === true,
    channelWebhooks,
    channelFeishuWebhooks,
    enableFeishuForward: dto.enableFeishuForward === true,
    enableDiscordForward: dto.enableDiscordForward !== false,
    feishuAppId: typeof dto.feishuAppId === "string" && dto.feishuAppId.trim() ? dto.feishuAppId.trim() : base.feishuAppId,
    feishuAppSecret:
      typeof dto.feishuAppSecret === "string" && dto.feishuAppSecret.trim()
        ? dto.feishuAppSecret.trim()
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
    excludeKeywords: Array.isArray(dto.excludeKeywords) ? dto.excludeKeywords : [],
    replacementsDictionary,
    allowedUsersIds: Array.isArray(dto.allowedUsersIds) ? dto.allowedUsersIds : base.allowedUsersIds || [],
    mutedUsersIds: Array.isArray(dto.mutedUsersIds) ? dto.mutedUsersIds : base.mutedUsersIds || [],
    restartNonce: dto.restartNonce ?? base.restartNonce,
    enableTranslation: dto.enableTranslation === true,
    translationProvider: dto.translationProvider || base.translationProvider || "deepseek",
    translationApiKey:
      typeof dto.translationApiKey === "string" && dto.translationApiKey.trim()
        ? dto.translationApiKey.trim()
        : typeof dto.deepseekApiKey === "string" && dto.deepseekApiKey.trim()
          ? dto.deepseekApiKey.trim()
          : base.translationApiKey,
    translationSecret:
      typeof dto.translationSecret === "string" && dto.translationSecret.trim()
        ? dto.translationSecret.trim()
        : base.translationSecret,
    deepseekApiKey:
      typeof dto.deepseekApiKey === "string" && dto.deepseekApiKey.trim()
        ? dto.deepseekApiKey.trim()
        : undefined,
    enableBotRelay: dto.enableBotRelay === true,
    botRelays: Array.isArray(dto.botRelays)
      ? dto.botRelays
          .filter((x: any) => x && typeof x.token === "string" && x.token.trim())
          .map((x: any) => ({
            id: typeof x.id === "string" && x.id.trim() ? x.id.trim() : randomUUID(),
            name: typeof x.name === "string" && x.name.trim() ? x.name.trim() : "中转机器人",
            token: x.token.trim(),
            loginState: typeof x.loginState === "string" ? x.loginState : "idle",
            loginMessage: typeof x.loginMessage === "string" ? x.loginMessage : "",
          }))
      : base.botRelays || [],
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
    ocrServerUrl: typeof dto.ocrServerUrl === "string" && dto.ocrServerUrl.trim() ? dto.ocrServerUrl.trim() : "http://localhost:9003",
    ocrBlockedKeywords: Array.isArray(dto.ocrBlockedKeywords) ? dto.ocrBlockedKeywords : [],
    feishuStyle: dto.feishuStyle === "style2" ? "style2" : (base.feishuStyle || "style1"),
    // Telegram认证配置保存
    telegramBotToken: typeof dto.telegramBotToken === "string" && dto.telegramBotToken.trim() ? dto.telegramBotToken.trim() : undefined,
    telegramApiId:
      typeof dto.telegramApiId === "number"
        ? dto.telegramApiId
        : typeof dto.telegramApiId === "string" && dto.telegramApiId.trim() && !isNaN(Number(dto.telegramApiId))
          ? Number(dto.telegramApiId)
          : undefined,
    telegramApiHash: typeof dto.telegramApiHash === "string" && dto.telegramApiHash.trim() ? dto.telegramApiHash.trim() : undefined,
    telegramSessionPath: typeof dto.telegramSessionPath === "string" && dto.telegramSessionPath.trim() ? dto.telegramSessionPath.trim() : undefined,
    telegramSessionString: typeof dto.telegramSessionString === "string" && dto.telegramSessionString.trim() ? dto.telegramSessionString.trim() : undefined,
    sessionType: dto.sessionType === "string" ? "string" : "file",
    // Telegram 超长消息处理配置
    enableTelegramOverflow: dto.enableTelegramOverflow === true,
    telegramOverflowThreshold: typeof dto.telegramOverflowThreshold === "number" && dto.telegramOverflowThreshold > 0 ? dto.telegramOverflowThreshold : 0,
    telegramOverflowMessage: typeof dto.telegramOverflowMessage === "string" && dto.telegramOverflowMessage.trim() ? dto.telegramOverflowMessage.trim() : "",
    // Telegram 配置（包含 accounts 和 mappings）
    telegramConfig: dto.telegramConfig && typeof dto.telegramConfig === "object" ? dto.telegramConfig : base.telegramConfig,
  };
}

export async function GET() {
  try {
    const multi = await getMultiConfig();
    const status = await readStatus();
    const telegramStatus = await readTelegramStatus();
    const payload: FrontendPayload = {
      accounts: multi.accounts.map((acc) => {
        const { botStatus, clientStatus } = resolveTelegramAccountStatuses(acc, telegramStatus);
        return {
          ...accountToFrontend(acc),
          ...(status[acc.id] || {}),
          telegramBotState: botStatus?.state || "idle",
          telegramBotMessage: botStatus?.message || "",
          telegramClientState: clientStatus?.state || "idle",
          telegramClientMessage: clientStatus?.message || "",
        };
      }),
      activeId: multi.activeId || multi.accounts[0]?.id || "",
      loginUser: multi.loginUser || "",
      loginPassword: multi.loginPassword || "",
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
    const body = await req.json();
    let next: MultiConfig;

    if (Array.isArray(body?.accounts)) {
      const current = await getMultiConfig();
      const accounts = (body.accounts as FrontendAccount[]).map((acc) => {
        const currentAccount = current.accounts.find((a) => a.id === acc.id);
        return dtoToAccount(acc, currentAccount);
      });
      const activeId = typeof body.activeId === "string" ? body.activeId : accounts[0]?.id;
      next = {
        accounts,
        activeId,
        loginUser: typeof body.loginUser === "string" ? body.loginUser : current.loginUser,
        loginPassword: typeof body.loginPassword === "string" ? body.loginPassword : current.loginPassword,
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
