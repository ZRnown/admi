import { getMultiConfig, saveMultiConfig, type AccountConfig, type MultiConfig } from "@/src/config";
import { promises as fs } from "fs";
import path from "path";

const statusFile = path.resolve(process.cwd(), ".data", "status.json");

// 用于触发配置重新加载的信号文件
const triggerFile = path.resolve(process.cwd(), ".data", "trigger_reload");

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

async function readStatus(): Promise<Record<string, { loginState?: string; loginMessage?: string }>> {
  try {
    const buf = await fs.readFile(statusFile, "utf-8");
    return JSON.parse(buf.toString());
  } catch {
    return {};
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { accountId, action } = body;

    if (!accountId || !action) {
      return new Response(JSON.stringify({ error: "Missing accountId or action" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (action === "login") {
      // 检查是否已经登录
      const status = await readStatus();
      const currentStatus = status[accountId];
      if (currentStatus?.loginState === "online") {
        return new Response(
          JSON.stringify({ error: "Account is already logged in", loginState: "online" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      // 更新配置并设置 pending 状态
      account.loginRequested = true;
      account.loginNonce = Date.now();
      await saveMultiConfig(multi);
      await writeStatus(accountId, "pending", "正在登录...");
      
      // 创建触发文件，让后端立即处理登录
      try {
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return new Response(
        JSON.stringify({ ok: true, loginState: "pending", loginMessage: "正在登录..." }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } else if (action === "stop") {
      // 更新配置并设置停止状态
      account.loginRequested = false;
      account.loginNonce = Date.now();
      await saveMultiConfig(multi);
      await writeStatus(accountId, "idle", "已停止该账号登录");
      
      // 创建触发文件，让后端立即处理停止
      try {
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return new Response(
        JSON.stringify({ ok: true, loginState: "idle", loginMessage: "已停止该账号登录" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } else {
      return new Response(JSON.stringify({ error: "Invalid action" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

