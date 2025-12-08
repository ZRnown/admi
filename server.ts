import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { type AccountConfig, getMultiConfig, saveMultiConfig, type MultiConfig } from "./src/config";

const app = express();
const PORT = (process.env.PORT ? parseInt(process.env.PORT, 10) : undefined) || 3000;

// 中间件
app.use(express.json());
app.use(express.static("public"));

// 工具函数
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
  deepseekApiKey?: string;
}

interface FrontendPayload {
  accounts: FrontendAccount[];
  activeId?: string;
}

const statusFile = path.resolve(process.cwd(), ".data", "status.json");
const triggerFile = path.resolve(process.cwd(), ".data", "trigger_reload");

async function readStatus(): Promise<Record<string, { loginState?: string; loginMessage?: string }>> {
  try {
    const buf = await fs.readFile(statusFile, "utf-8");
    return JSON.parse(buf.toString());
  } catch {
    return {};
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
    deepseekApiKey: account.deepseekApiKey || "",
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
    channelNotes,
    blockedKeywords: Array.isArray(dto.blockedKeywords) ? dto.blockedKeywords : [],
    excludeKeywords: Array.isArray(dto.excludeKeywords) ? dto.excludeKeywords : [],
    replacementsDictionary,
    allowedUsersIds: Array.isArray(dto.allowedUsersIds) ? dto.allowedUsersIds : base.allowedUsersIds || [],
    mutedUsersIds: Array.isArray(dto.mutedUsersIds) ? dto.mutedUsersIds : base.mutedUsersIds || [],
    restartNonce: dto.restartNonce ?? base.restartNonce,
    enableTranslation: dto.enableTranslation === true,
    deepseekApiKey: typeof dto.deepseekApiKey === "string" && dto.deepseekApiKey.trim() ? dto.deepseekApiKey.trim() : undefined,
  };
}

// API 路由
app.get("/api/config", async (req: Request, res: Response) => {
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
    res.json(payload);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/config", async (req: Request, res: Response) => {
  try {
    const body = req.body;
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
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post("/api/account/action", async (req: Request, res: Response) => {
  try {
    const { accountId, action } = req.body;

    if (!accountId || !action) {
      return res.status(400).json({ error: "Missing accountId or action" });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    if (action === "login") {
      const status = await readStatus();
      const currentStatus = status[accountId];
      if (currentStatus?.loginState === "online") {
        return res.status(400).json({ error: "Account is already logged in", loginState: "online" });
      }

      account.loginRequested = true;
      account.loginNonce = Date.now();
      await saveMultiConfig(multi);
      await writeStatus(accountId, "pending", "正在登录...");

      try {
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return res.json({ ok: true, loginState: "pending", loginMessage: "正在登录..." });
    } else if (action === "stop") {
      account.loginRequested = false;
      account.loginNonce = Date.now();
      await saveMultiConfig(multi);
      await writeStatus(accountId, "idle", "已停止该账号登录");

      try {
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return res.json({ ok: true, loginState: "idle", loginMessage: "已停止该账号登录" });
    } else {
      return res.status(400).json({ error: "Invalid action" });
    }
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`管理界面服务器运行在 http://localhost:${PORT}`);
  console.log(`后端 Bot 请单独运行: pnpm start:bot`);
});

