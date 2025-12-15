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
    const { accountId, action, relayIds } = await req.json();

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
      // 验证一个或多个中转机器人 token
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
                  resolve({ success: false, error: err.message || `验证失败 (HTTP ${rs.statusCode})` });
                } catch {
                  resolve({ success: false, error: `验证失败 (HTTP ${rs.statusCode})` });
                }
              }
            });
          });
          rq.on("error", (err: any) => resolve({ success: false, error: `网络错误: ${err.message}` }));
          rq.setTimeout(15000, () => {
            rq.destroy();
            resolve({ success: false, error: "验证超时（15秒）" });
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
          relay.loginMessage = "正在验证 Token...";
          const resp = await verifyRelay(relay.token.trim());
          if (resp.success) {
            relay.loginState = "online";
            relay.loginMessage = "验证成功";
          } else {
            relay.loginState = "error";
            relay.loginMessage = resp.error || "验证失败";
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
          relay.loginMessage = `验证异常: ${String(e?.message || e)}`;
          results[relay.id] = { loginState: relay.loginState, loginMessage: relay.loginMessage };
        }
        await saveMultiConfig(multi);
        return NextResponse.json({ error: String(e?.message || e), results }, { status: 500 });
      }
    } else {
      return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

