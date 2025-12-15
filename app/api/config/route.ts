import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { type AccountConfig, getMultiConfig, saveMultiConfig, type MultiConfig } from "@/src/config";
import { readStatus, triggerFile } from "../_lib/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface FrontendMapping {
  id: string;
  sourceChannelId: string;
  targetWebhookUrl: string;
  note?: string;
}

interface FrontendAccount {
  id: string;
  name: string;
  type: "bot" | "selfbot";
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
  channelFeishuWebhooks?: Record<string, string>;
  enableFeishuForward?: boolean;
  enableDiscordForward?: boolean;
  ignoreSelf?: boolean;
  ignoreBot?: boolean;
  ignoreImages?: boolean;
  ignoreAudio?: boolean;
  ignoreVideo?: boolean;
  ignoreDocuments?: boolean;
}

interface FrontendPayload {
  accounts: FrontendAccount[];
  activeId?: string;
}

function accountToFrontend(account: AccountConfig): FrontendAccount {
  const mappings: FrontendMapping[] = [];
  for (const [channelId, webhookUrl] of Object.entries(account.channelWebhooks || {})) {
    mappings.push({
      id: channelId,
      sourceChannelId: channelId,
      targetWebhookUrl: webhookUrl,
      note: account.channelNotes?.[channelId],
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
    channelFeishuWebhooks: account.channelFeishuWebhooks || {},
    enableFeishuForward: account.enableFeishuForward === true,
    enableDiscordForward: account.enableDiscordForward !== false,
    ignoreSelf: account.ignoreSelf === true,
    ignoreBot: account.ignoreBot === true,
    ignoreImages: account.ignoreImages === true,
    ignoreAudio: account.ignoreAudio === true,
    ignoreVideo: account.ignoreVideo === true,
    ignoreDocuments: account.ignoreDocuments === true,
  };
}

function dtoToAccount(dto: FrontendAccount, fallback?: AccountConfig): AccountConfig {
  const base: AccountConfig =
    fallback ??
    ({
      id: randomUUID(),
      name: dto.name || "未命名转发实例",
      type: dto.type === "bot" ? "bot" : "selfbot",
      token: dto.token || "",
      proxyUrl: dto.proxyUrl || "",
      channelWebhooks: {},
      channelFeishuWebhooks: {},
      enableFeishuForward: false,
      enableDiscordForward: true,
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
    } as AccountConfig);

  const channelWebhooks: Record<string, string> = {};
  const channelNotes: Record<string, string> = {};
  if (Array.isArray(dto.mappings)) {
    for (const mapping of dto.mappings) {
      if (mapping?.sourceChannelId && mapping?.targetWebhookUrl) {
        const key = String(mapping.sourceChannelId);
        channelWebhooks[key] = String(mapping.targetWebhookUrl);
        if (typeof mapping.note === "string" && mapping.note.trim()) {
          channelNotes[key] = mapping.note.trim();
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
  const channelFeishuWebhooks =
    dto.channelFeishuWebhooks && typeof dto.channelFeishuWebhooks === "object"
      ? dto.channelFeishuWebhooks
      : {};

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
    token: dto.token || "",
    proxyUrl: dto.proxyUrl || "",
    loginRequested,
    loginNonce: dto.loginNonce ?? base.loginNonce,
    showSourceIdentity: dto.showSourceIdentity === true,
    channelWebhooks,
    channelFeishuWebhooks,
    enableFeishuForward: dto.enableFeishuForward === true,
    enableDiscordForward: dto.enableDiscordForward !== false,
    channelNotes,
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
  };
}

export async function GET() {
  try {
    const multi = await getMultiConfig();
    const status = await readStatus();
    const payload: FrontendPayload = {
      accounts: multi.accounts.map((acc) => ({
        ...accountToFrontend(acc),
        ...(status[acc.id] || {}),
      })),
      activeId: multi.activeId || multi.accounts[0]?.id || "",
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
      next = { accounts, activeId };
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

