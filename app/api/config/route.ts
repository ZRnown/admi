import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { type AccountConfig, getMultiConfig, saveMultiConfig, type MultiConfig } from "@/src/config";

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
  };
}

function dtoToAccount(dto: FrontendAccount, fallback?: AccountConfig): AccountConfig {
  const base: AccountConfig =
    fallback ??
    ({
      id: randomUUID(),
      name: dto.name || "未命名账号",
      type: dto.type === "bot" ? "bot" : "selfbot",
      token: dto.token || "",
      proxyUrl: dto.proxyUrl || "",
      channelWebhooks: {},
      channelNotes: {},
      blockedKeywords: [],
      excludeKeywords: [],
      showSourceIdentity: dto.showSourceIdentity === true,
      replacementsDictionary: {},
      historyScan: { enabled: true },
      showChat: true,
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

  // 如果 fallback 存在且 loginRequested 是 true，而 dto.loginRequested 不是 true（可能是 false 或 undefined），
  // 则保留 fallback 的 loginRequested，避免已登录账号被错误重置
  // 只有当 dto 明确设置为 true 时才更新为 true，只有当 dto 明确设置为 false 时才更新为 false
  let loginRequested: boolean;
  if (fallback && fallback.loginRequested === true) {
    // 如果当前配置中 loginRequested 是 true，只有当 dto 明确设置为 false 时才更新
    loginRequested = dto.loginRequested === false ? false : true;
  } else {
    // 如果当前配置中 loginRequested 不是 true，则使用 dto 的值
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
    // loginState/loginMessage 由后端运行态写入，不从前端覆盖
    showSourceIdentity: dto.showSourceIdentity === true,
    channelWebhooks,
    channelNotes,
    blockedKeywords: Array.isArray(dto.blockedKeywords) ? dto.blockedKeywords : [],
    excludeKeywords: Array.isArray(dto.excludeKeywords) ? dto.excludeKeywords : [],
    replacementsDictionary,
    allowedUsersIds: Array.isArray(dto.allowedUsersIds) ? dto.allowedUsersIds : base.allowedUsersIds || [],
    mutedUsersIds: Array.isArray(dto.mutedUsersIds) ? dto.mutedUsersIds : base.mutedUsersIds || [],
    restartNonce: dto.restartNonce ?? base.restartNonce,
  };
}

function legacyBodyToMulti(body: any): MultiConfig {
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
  return { accounts: [account], activeId: id };
}

async function readStatus(): Promise<Record<string, { loginState?: string; loginMessage?: string }>> {
  try {
    const p = path.resolve(process.cwd(), ".data", "status.json");
    const buf = await fs.readFile(p, "utf-8");
    return JSON.parse(buf.toString());
  } catch {
    return {};
  }
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
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    let next: MultiConfig;

    if (Array.isArray(body?.accounts)) {
      // 读取当前配置，确保保留 loginRequested 状态
      const current = await getMultiConfig();
      const accounts = (body.accounts as FrontendAccount[]).map((acc) => {
        const currentAccount = current.accounts.find(a => a.id === acc.id);
        // dtoToAccount 函数已经处理了 loginRequested 的保留逻辑
        return dtoToAccount(acc, currentAccount);
      });
      const activeId = typeof body.activeId === "string" ? body.activeId : accounts[0]?.id;
      next = { accounts, activeId };
    } else {
      // 兼容旧版请求
      next = legacyBodyToMulti(body);
    }

    await saveMultiConfig(next);

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
