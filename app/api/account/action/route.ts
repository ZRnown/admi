import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import https from "https";
import { ProxyAgent } from "proxy-agent";
import { getMultiConfig, saveMultiConfig } from "@/src/config";
import { readStatus, writeStatus, triggerFile } from "../../_lib/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { accountId, action, relayIds, safewIds } = await req.json();

    if (!accountId || !action) {
      return NextResponse.json({ error: "Missing accountId or action" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    if (action === "login") {
      const status = await readStatus();
      const currentStatus = status[accountId];
      if (currentStatus?.loginState === "online") {
        return NextResponse.json(
          { error: "Account is already logged in", loginState: "online" },
          { status: 400 },
        );
      }

      account.loginRequested = true;
      account.loginNonce = Date.now();
      await saveMultiConfig(multi);
      await writeStatus(accountId, "pending", "正在登录...");

      try {
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return NextResponse.json({ ok: true, loginState: "pending", loginMessage: "正在登录..." });
    } else if (action === "stop") {
      account.loginRequested = false;
      account.loginNonce = Date.now();
      await saveMultiConfig(multi);
      await writeStatus(accountId, "idle", "已停止该账号登录");

      try {
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return NextResponse.json({ ok: true, loginState: "idle", loginMessage: "已停止该账号登录" });
    } else if (action === "relayLogin") {
      // 登录一个或多个中转机器人 token
      const relayIdList = Array.isArray(relayIds)
        ? relayIds.filter((x: any) => typeof x === "string")
        : undefined;

      if (!Array.isArray(account.botRelays) || account.botRelays.length === 0) {
        return NextResponse.json({ error: "No relay configured" }, { status: 400 });
      }

      const envProxy = process.env.PROXY_URL;
      const proxy = account.proxyUrl || envProxy;
      const httpAgent = proxy ? new ProxyAgent(proxy as any) : undefined;

      const targets =
        relayIdList && relayIdList.length > 0
          ? account.botRelays.filter((r) => relayIdList.includes(r.id))
          : account.botRelays;

      if (targets.length === 0) {
        return NextResponse.json({ error: "No relay matched" }, { status: 400 });
      }

      const verifyRelay = async (token: string): Promise<{ success: boolean; error?: string }> => {
        const options: any = {
          hostname: "discord.com",
          path: "/api/v10/users/@me",
          method: "GET",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "DiscordBot (https://discord.com, 1.0)",
          },
        };
        if (httpAgent) options.agent = httpAgent;

        return await new Promise((resolve) => {
          const rq = https.request(options, (rs: any) => {
            let body = "";
            rs.on("data", (c: any) => (body += c));
            rs.on("end", () => {
              if (rs.statusCode === 200) {
                try {
                  const data = JSON.parse(body);
                  if (data.id && data.bot === true) {
                    resolve({ success: true });
                  } else if (data.id && !data.bot) {
                    resolve({ success: false, error: "Token 不是机器人 Token（是用户 Token）" });
                  } else {
                    resolve({ success: false, error: "Token 不是机器人 Token" });
                  }
                } catch (e: any) {
                  resolve({ success: false, error: `解析响应失败: ${String(e?.message || e)}` });
                }
              } else if (rs.statusCode === 401) {
                resolve({ success: false, error: "Token 无效或已过期" });
              } else {
                try {
                  const err = body ? JSON.parse(body) : {};
                  resolve({ success: false, error: err.message || `登录失败 (HTTP ${rs.statusCode})` });
                } catch {
                  resolve({ success: false, error: `登录失败 (HTTP ${rs.statusCode})` });
                }
              }
            });
          });
          rq.on("error", (err: any) => resolve({ success: false, error: `网络错误: ${err.message}` }));
          rq.setTimeout(15000, () => {
            rq.destroy();
            resolve({ success: false, error: "登录超时（15秒）" });
          });
          rq.end();
        });
      };

      const results: Record<string, { loginState: string; loginMessage: string }> = {};

      try {
        for (const relay of targets) {
          if (!relay.token || !relay.token.trim()) {
            relay.loginState = "error";
            relay.loginMessage = "Token 未配置";
            results[relay.id] = { loginState: "error", loginMessage: "Token 未配置" };
            continue;
          }

          relay.loginState = "pending";
          relay.loginMessage = "正在登录 Token...";
          const resp = await verifyRelay(relay.token.trim());
          if (resp.success) {
            relay.loginState = "online";
            relay.loginMessage = "登录成功";
          } else {
            relay.loginState = "error";
            relay.loginMessage = resp.error || "登录失败";
          }
          results[relay.id] = { loginState: relay.loginState, loginMessage: relay.loginMessage };
        }

        await saveMultiConfig(multi);
        try {
          await fs.mkdir(path.dirname(triggerFile), { recursive: true });
          await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
        } catch {}

        return NextResponse.json({ ok: true, results });
      } catch (e: any) {
        // 意外异常时，将目标 relay 标记为错误，避免停留在 pending
        for (const relay of targets) {
          relay.loginState = "error";
          relay.loginMessage = `登录异常: ${String(e?.message || e)}`;
          results[relay.id] = { loginState: relay.loginState, loginMessage: relay.loginMessage };
        }
        await saveMultiConfig(multi);
        return NextResponse.json({ error: String(e?.message || e), results }, { status: 500 });
      }
    } else if (action === "safewLogin") {
      const safewIdList = Array.isArray(safewIds)
        ? safewIds.filter((x: any) => typeof x === "string")
        : undefined;
      const safewAccounts = Array.isArray((account as any).safewAccounts) ? (account as any).safewAccounts : [];
      if (safewAccounts.length === 0) {
        return NextResponse.json({ error: "No SafeW bot configured" }, { status: 400 });
      }
      const targets =
        safewIdList && safewIdList.length > 0
          ? safewAccounts.filter((item: any) => safewIdList.includes(item.id))
          : safewAccounts;
      if (targets.length === 0) {
        return NextResponse.json({ error: "No SafeW bot matched" }, { status: 400 });
      }

      const verifySafewBot = async (token: string): Promise<{ success: boolean; name?: string; error?: string }> => {
        const cleanToken = String(token || "").trim().replace(/^bot\s+/i, "");
        if (!cleanToken) return { success: false, error: "Token 未配置" };
        const options: https.RequestOptions = {
          hostname: "api.safew.bot",
          path: `/bot${encodeURIComponent(cleanToken)}/getme`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "DiscordBotWork/1.0",
          },
        };
        const proxy = account.proxyUrl || process.env.PROXY_URL;
        if (proxy) options.agent = new ProxyAgent(proxy as any) as any;

        return await new Promise((resolve) => {
          const rq = https.request(options, (rs: any) => {
            let body = "";
            rs.on("data", (c: any) => (body += c));
            rs.on("end", () => {
              let parsed: any = {};
              try {
                parsed = body ? JSON.parse(body) : {};
              } catch {
                parsed = { raw: body };
              }
              if (rs.statusCode && rs.statusCode >= 200 && rs.statusCode < 300 && parsed?.ok !== false) {
                const result = parsed?.result || parsed?.data || parsed;
                const name =
                  typeof result?.username === "string" && result.username.trim()
                    ? `@${result.username.trim().replace(/^@+/, "")}`
                    : typeof result?.first_name === "string" && result.first_name.trim()
                      ? result.first_name.trim()
                      : typeof result?.name === "string" && result.name.trim()
                        ? result.name.trim()
                        : "登录成功";
                resolve({ success: true, name });
                return;
              }
              if (rs.statusCode === 401) {
                resolve({ success: false, error: "Token 无效或已过期" });
                return;
              }
              resolve({
                success: false,
                error: parsed?.description || parsed?.message || `登录失败 (HTTP ${rs.statusCode})`,
              });
            });
          });
          rq.on("error", (err: any) => resolve({ success: false, error: `网络错误: ${err.message}` }));
          rq.setTimeout(15000, () => {
            rq.destroy();
            resolve({ success: false, error: "登录超时（15秒）" });
          });
          rq.end();
        });
      };

      const results: Record<string, { loginState: string; loginMessage: string }> = {};
      try {
        for (const bot of targets) {
          bot.loginState = "pending";
          bot.loginMessage = "正在校验 Token...";
          const verified = await verifySafewBot(bot.botToken);
          if (verified.success) {
            bot.loginState = "online";
            bot.loginMessage = verified.name || "登录成功";
          } else {
            bot.loginState = "error";
            bot.loginMessage = verified.error || "登录失败";
          }
          results[bot.id] = { loginState: bot.loginState, loginMessage: bot.loginMessage };
        }
        await saveMultiConfig(multi);
        return NextResponse.json({ ok: true, results });
      } catch (e: any) {
        for (const bot of targets) {
          bot.loginState = "error";
          bot.loginMessage = `登录异常: ${String(e?.message || e)}`;
          results[bot.id] = { loginState: bot.loginState, loginMessage: bot.loginMessage };
        }
        await saveMultiConfig(multi);
        return NextResponse.json({ error: String(e?.message || e), results }, { status: 500 });
      }
    } else if (action === "safewStop") {
      const safewIdList = Array.isArray(safewIds)
        ? safewIds.filter((x: any) => typeof x === "string")
        : undefined;
      const safewAccounts = Array.isArray((account as any).safewAccounts) ? (account as any).safewAccounts : [];
      const targets =
        safewIdList && safewIdList.length > 0
          ? safewAccounts.filter((item: any) => safewIdList.includes(item.id))
          : safewAccounts;
      const results: Record<string, { loginState: string; loginMessage: string }> = {};
      for (const bot of targets) {
        bot.loginState = "idle";
        bot.loginMessage = "已停止";
        results[bot.id] = { loginState: bot.loginState, loginMessage: bot.loginMessage };
      }
      await saveMultiConfig(multi);
      return NextResponse.json({ ok: true, results });
    } else if (action === "safewGroups") {
      const safewIdList = Array.isArray(safewIds)
        ? safewIds.filter((x: any) => typeof x === "string")
        : undefined;
      const safewAccounts = Array.isArray((account as any).safewAccounts) ? (account as any).safewAccounts : [];
      const targets =
        safewIdList && safewIdList.length > 0
          ? safewAccounts.filter((item: any) => safewIdList.includes(item.id))
          : safewAccounts;
      if (targets.length === 0) {
        return NextResponse.json({ error: "No SafeW bot matched" }, { status: 400 });
      }

      const fetchGroups = async (token: string): Promise<{ success: boolean; groups?: any[]; error?: string }> => {
        const cleanToken = String(token || "").trim().replace(/^bot\s+/i, "");
        if (!cleanToken) return { success: false, error: "Token 未配置" };
        const options: https.RequestOptions = {
          hostname: "api.safew.bot",
          path: `/bot${encodeURIComponent(cleanToken)}/getupdates`,
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "DiscordBotWork/1.0",
          },
        };
        const proxy = account.proxyUrl || process.env.PROXY_URL;
        if (proxy) options.agent = new ProxyAgent(proxy as any) as any;

        return await new Promise((resolve) => {
          const rq = https.request(options, (rs: any) => {
            let body = "";
            rs.on("data", (c: any) => (body += c));
            rs.on("end", () => {
              let parsed: any = {};
              try {
                parsed = body ? JSON.parse(body) : {};
              } catch {
                parsed = { raw: body };
              }
              if (!rs.statusCode || rs.statusCode < 200 || rs.statusCode >= 300 || parsed?.ok === false) {
                resolve({
                  success: false,
                  error: parsed?.description || parsed?.message || `获取失败 (HTTP ${rs.statusCode})`,
                });
                return;
              }
              const updates = Array.isArray(parsed?.result)
                ? parsed.result
                : Array.isArray(parsed?.data)
                  ? parsed.data
                  : Array.isArray(parsed)
                    ? parsed
                    : [];
              const byId = new Map<string, any>();
              for (const update of updates) {
                const containers = [
                  update?.message,
                  update?.edited_message,
                  update?.channel_post,
                  update?.edited_channel_post,
                  update?.my_chat_member,
                  update?.chat_member,
                ];
                for (const item of containers) {
                  const chat = item?.chat || item;
                  const id = chat?.id;
                  if (id === undefined || id === null) continue;
                  const idText = String(id);
                  if (!idText) continue;
                  const title =
                    typeof chat?.title === "string" && chat.title.trim()
                      ? chat.title.trim()
                      : [chat?.first_name, chat?.last_name].filter(Boolean).join(" ").trim() ||
                        (typeof chat?.username === "string" ? `@${chat.username.replace(/^@+/, "")}` : "") ||
                        "未命名群组";
                  byId.set(idText, {
                    id: idText,
                    title,
                    type: typeof chat?.type === "string" ? chat.type : undefined,
                  });
                }
              }
              resolve({ success: true, groups: Array.from(byId.values()) });
            });
          });
          rq.on("error", (err: any) => resolve({ success: false, error: `网络错误: ${err.message}` }));
          rq.setTimeout(15000, () => {
            rq.destroy();
            resolve({ success: false, error: "获取超时（15秒）" });
          });
          rq.end();
        });
      };

      const normalizeSafewGroup = (group: any) => {
        if (!group || group.id === undefined || group.id === null) return null;
        return {
          id: String(group.id),
          title: typeof group.title === "string" && group.title.trim() ? group.title.trim() : "未命名群组",
          type: typeof group.type === "string" && group.type.trim() ? group.type.trim() : undefined,
        };
      };
      const mergeSafewGroups = (cached: any, fetched: any) => {
        const byId = new Map<string, any>();
        for (const group of Array.isArray(cached) ? cached : []) {
          const normalized = normalizeSafewGroup(group);
          if (normalized) byId.set(normalized.id, normalized);
        }
        for (const group of Array.isArray(fetched) ? fetched : []) {
          const normalized = normalizeSafewGroup(group);
          if (normalized) byId.set(normalized.id, normalized);
        }
        return Array.from(byId.values());
      };

      const results: Record<string, { groups?: any[]; refreshedCount?: number; error?: string }> = {};
      for (const bot of targets) {
        const result = await fetchGroups(bot.botToken);
        if (result.success) {
          const fetchedGroups = result.groups || [];
          bot.groups = mergeSafewGroups(bot.groups, fetchedGroups);
          results[bot.id] = { groups: bot.groups, refreshedCount: fetchedGroups.length };
        } else {
          results[bot.id] = { error: result.error || "获取失败" };
        }
      }
      await saveMultiConfig(multi);
      return NextResponse.json({ ok: true, results });
    } else {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
