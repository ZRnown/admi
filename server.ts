import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { execSync } from "child_process";
import path from "path";
import https from "https";
import { ProxyAgent } from "proxy-agent";
import { type AccountConfig, getMultiConfig, saveMultiConfig, type MultiConfig } from "./src/config";
import { getEnv } from "./src/env";

// 加载 .env 文件
dotenv.config();

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
  translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
  translationApiKey?: string;
  translationSecret?: string;
  deepseekApiKey?: string;
  enableBotRelay?: boolean;
  botRelayToken?: string;
  botRelayUseWebhook?: boolean;
  botRelayLoginState?: string;
  botRelayLoginMessage?: string;
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
    translationProvider: account.translationProvider || "deepseek",
    translationApiKey: account.translationApiKey || account.deepseekApiKey || "",
    translationSecret: account.translationSecret || "",
    deepseekApiKey: account.deepseekApiKey || "",
    enableBotRelay: account.enableBotRelay === true,
    botRelayToken: account.botRelayToken || "",
    botRelayUseWebhook: account.botRelayUseWebhook === true,
    botRelayLoginState: account.botRelayLoginState || "idle",
    botRelayLoginMessage: account.botRelayLoginMessage || "",
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
      botRelayToken: dto.botRelayToken || "",
      botRelayUseWebhook: dto.botRelayUseWebhook === true,
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
    translationProvider: dto.translationProvider || base.translationProvider || "deepseek",
    translationApiKey: typeof dto.translationApiKey === "string" && dto.translationApiKey.trim() ? dto.translationApiKey.trim() : (typeof dto.deepseekApiKey === "string" && dto.deepseekApiKey.trim() ? dto.deepseekApiKey.trim() : base.translationApiKey),
    translationSecret: typeof dto.translationSecret === "string" && dto.translationSecret.trim() ? dto.translationSecret.trim() : base.translationSecret,
    deepseekApiKey: typeof dto.deepseekApiKey === "string" && dto.deepseekApiKey.trim() ? dto.deepseekApiKey.trim() : undefined,
    enableBotRelay: dto.enableBotRelay === true,
    botRelayToken: typeof dto.botRelayToken === "string" && dto.botRelayToken.trim() ? dto.botRelayToken.trim() : base.botRelayToken,
    ignoreSelf: dto.ignoreSelf === true,
    ignoreBot: dto.ignoreBot === true,
    ignoreImages: dto.ignoreImages === true,
    ignoreAudio: dto.ignoreAudio === true,
    ignoreVideo: dto.ignoreVideo === true,
    ignoreDocuments: dto.ignoreDocuments === true,
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
    } else if (action === "botRelayLogin") {
      // 机器人中转登录逻辑：验证token是否有效
      console.log(`[机器人中转] 账号 "${account.name}" 开始验证 Token`);
      
      if (!account.botRelayToken || !account.botRelayToken.trim()) {
        console.error(`[机器人中转] 账号 "${account.name}" Token 未配置`);
        account.botRelayLoginState = "error";
        account.botRelayLoginMessage = "Token 未配置";
        await saveMultiConfig(multi);
        return res.json({ ok: false, botRelayLoginState: "error", botRelayLoginMessage: "Token 未配置" });
      }

      // 先设置pending状态并保存
      account.botRelayLoginState = "pending";
      account.botRelayLoginMessage = "正在验证 Token...";
      await saveMultiConfig(multi);
      console.log(`[机器人中转] 账号 "${account.name}" 状态已设置为 pending`);

      // 验证机器人Token是否有效
      try {
        const token = account.botRelayToken.trim();
        
        // 获取代理配置（如果有）
        const env = getEnv();
        const proxy = account.proxyUrl || env.PROXY_URL;
        const httpAgent = proxy ? new ProxyAgent(proxy as any) : undefined;
        
        console.log(`[机器人中转] 账号 "${account.name}" 开始验证请求，使用代理: ${proxy ? '是' : '否'}`);
        
        const options: any = {
          hostname: "discord.com",
          path: "/api/v10/users/@me",
          method: "GET",
          headers: {
            "Authorization": `Bot ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "DiscordBot (https://discord.com, 1.0)"
          }
        };
        
        if (httpAgent) {
          options.agent = httpAgent;
        }

        const verifyResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
          const req = https.request(options, (res: any) => {
            let body = "";
            res.on("data", (chunk: any) => (body += chunk));
            res.on("end", () => {
              console.log(`[机器人中转] 账号 "${account.name}" 验证响应: HTTP ${res.statusCode}`);
              if (res.statusCode === 200) {
                try {
                  const data = JSON.parse(body);
                  console.log(`[机器人中转] 账号 "${account.name}" 验证响应数据:`, { id: data.id, bot: data.bot, username: data.username });
                  if (data.id && data.bot === true) {
                    resolve({ success: true });
                  } else if (data.id && !data.bot) {
                    resolve({ success: false, error: "Token 不是机器人 Token（是用户 Token）" });
                  } else {
                    resolve({ success: false, error: "Token 不是机器人 Token" });
                  }
                } catch (e: any) {
                  console.error(`[机器人中转] 账号 "${account.name}" 解析响应失败:`, e);
                  resolve({ success: false, error: `解析响应失败: ${String(e?.message || e)}` });
                }
              } else if (res.statusCode === 401) {
                console.error(`[机器人中转] 账号 "${account.name}" Token 无效或已过期`);
                resolve({ success: false, error: "Token 无效或已过期" });
              } else {
                try {
                  const errorData = body ? JSON.parse(body) : {};
                  const errorMsg = errorData.message || `验证失败 (HTTP ${res.statusCode})`;
                  console.error(`[机器人中转] 账号 "${account.name}" 验证失败:`, errorMsg);
                  resolve({ success: false, error: errorMsg });
                } catch {
                  console.error(`[机器人中转] 账号 "${account.name}" 验证失败: HTTP ${res.statusCode}`);
                  resolve({ success: false, error: `验证失败 (HTTP ${res.statusCode})` });
                }
              }
            });
          });
          req.on("error", (err: any) => {
            console.error(`[机器人中转] 账号 "${account.name}" 网络错误:`, err);
            resolve({ success: false, error: `网络错误: ${err.message}` });
          });
          req.setTimeout(15000, () => {
            console.error(`[机器人中转] 账号 "${account.name}" 验证超时`);
            req.destroy();
            resolve({ success: false, error: "验证超时（15秒）" });
          });
          req.end();
        });

        // 根据验证结果更新状态
        if (verifyResult.success) {
          account.botRelayLoginState = "online";
          account.botRelayLoginMessage = "验证成功";
          await saveMultiConfig(multi);
          console.log(`[机器人中转] 账号 "${account.name}" Token 验证成功，状态已更新为 online`);
          return res.json({ ok: true, botRelayLoginState: "online", botRelayLoginMessage: "验证成功" });
        } else {
          account.botRelayLoginState = "error";
          account.botRelayLoginMessage = verifyResult.error || "验证失败";
          await saveMultiConfig(multi);
          console.error(`[机器人中转] 账号 "${account.name}" Token 验证失败: ${verifyResult.error || "验证失败"}，状态已更新为 error`);
          return res.json({ ok: false, botRelayLoginState: "error", botRelayLoginMessage: verifyResult.error || "验证失败" });
        }
      } catch (e: any) {
        const errorMsg = `验证异常: ${String(e?.message || e)}`;
        console.error(`[机器人中转] 账号 "${account.name}" Token 验证异常:`, e);
        account.botRelayLoginState = "error";
        account.botRelayLoginMessage = errorMsg;
        await saveMultiConfig(multi);
        return res.json({ ok: false, botRelayLoginState: "error", botRelayLoginMessage: errorMsg });
      }
    } else if (action === "botRelayStop") {
      // 机器人中转停止逻辑
      account.botRelayLoginState = "idle";
      account.botRelayLoginMessage = "已停止";
      await saveMultiConfig(multi);

      try {
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return res.json({ ok: true, botRelayLoginState: "idle", botRelayLoginMessage: "已停止" });
    } else {
      return res.status(400).json({ error: "Invalid action" });
    }
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// 启动服务器（自动处理端口冲突）
const server = app.listen(PORT, () => {
  console.log(`管理界面服务器运行在 http://localhost:${PORT}`);
  console.log(`后端 Bot 请单独运行: pnpm start:bot`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 错误：端口 ${PORT} 已被占用！`);
    console.error(`\n解决方案：`);
    console.error(`1. 杀掉占用端口的进程：`);
    console.error(`   lsof -ti:${PORT} | xargs kill -9`);
    console.error(`2. 或者使用其他端口：`);
    console.error(`   PORT=3001 pnpm start:server`);
    console.error(`\n当前占用端口的进程：`);
    try {
      const pid = execSync(`lsof -ti:${PORT}`, { encoding: 'utf-8' }).trim();
      const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim();
      console.error(`   PID: ${pid}`);
      console.error(`   命令: ${cmd.substring(0, 100)}...`);
    } catch (e) {
      console.error(`   无法获取进程信息`);
    }
    process.exit(1);
  } else {
    throw err;
  }
});

