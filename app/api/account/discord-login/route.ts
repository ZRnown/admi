import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig, saveMultiConfig } from "@/src/config";
import { writeDiscordLibraryStatus, writeStatus, triggerFile } from "../../_lib/common";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginRequestFile = path.resolve(process.cwd(), ".data", "discord_login_request.json");
const loginResponseFile = path.resolve(process.cwd(), ".data", "discord_login_response.json");

async function waitForLoginResponse(requestId: string, maxWaitMs = 120000): Promise<any | null> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    try {
      const raw = await fs.readFile(loginResponseFile, "utf-8");
      const response = JSON.parse(raw);
      if (response?.id === requestId) {
        await fs.unlink(loginResponseFile).catch(() => {});
        return response;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";
    const discordAccountId = typeof body?.discordAccountId === "string" ? body.discordAccountId : "";
    const useLibrary = body?.useLibrary === true || (!accountId && !!discordAccountId);
    const mode = body?.mode === "password" ? "password" : "token";

    if (!accountId && !useLibrary) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    if (useLibrary) {
      if (!discordAccountId) {
        return NextResponse.json({ error: "缺少 discordAccountId" }, { status: 400 });
      }
      if (!multi.discordAccounts) multi.discordAccounts = [];
      let account = multi.discordAccounts.find((acc) => acc.id === discordAccountId);
      if (!account) {
        return NextResponse.json({ error: "账号不存在" }, { status: 404 });
      }

      const respondLibraryError = async (message: string, status = 400) => {
        await writeDiscordLibraryStatus(discordAccountId, "error", message);
        return NextResponse.json({ error: message }, { status });
      };

      if (mode === "token") {
        const token = typeof body?.token === "string" ? body.token.trim() : "";
        if (!token) {
          return respondLibraryError("缺少 token", 400);
        }
        const accountType = body?.accountType === "bot" ? "bot" : "selfbot";
        account.token = token;
        account.type = accountType;
        await saveMultiConfig(multi);
        try {
          await fs.mkdir(path.dirname(triggerFile), { recursive: true });
          await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
        } catch {}
        return NextResponse.json({ ok: true, tokenStored: true });
      }

      if (account.type === "bot") {
        return respondLibraryError("机器人账号仅支持 Token 登录", 400);
      }

      const email = typeof body?.email === "string" ? body.email.trim() : "";
      const password = typeof body?.password === "string" ? body.password : "";
      const totpSecret = typeof body?.totpSecret === "string" ? body.totpSecret.trim() : undefined;

      if (!email || !password) {
        return respondLibraryError("缺少邮箱或密码", 400);
      }

      await fs.mkdir(path.dirname(loginRequestFile), { recursive: true });
      try {
        await fs.access(loginRequestFile);
        return NextResponse.json({ error: "已有登录请求处理中，请稍后" }, { status: 409 });
      } catch {}

      const requestId = randomUUID();
      await fs.writeFile(
        loginRequestFile,
        JSON.stringify(
          {
            id: requestId,
            action: "password",
            params: { email, password, totpSecret },
            createdAt: Date.now(),
          },
          null,
          2,
        ),
      );

      const response = await waitForLoginResponse(requestId, 120000);
      if (!response) {
        return respondLibraryError("登录请求超时", 504);
      }

      if (!response.success) {
        const detail = response?.result?.message || response?.message;
        const error =
          response?.error && detail ? `${response.error}: ${detail}` : response?.error || detail || "登录失败";
        return respondLibraryError(error, 400);
      }

      const token = response?.result?.token;
      if (!token) {
        return respondLibraryError("登录失败，未获取到 Token", 500);
      }

      account.token = token;
      account.type = "selfbot";
      account.email = email;
      account.password = password;
      account.totpSecret = totpSecret;
      await saveMultiConfig(multi);
      try {
        await fs.mkdir(path.dirname(triggerFile), { recursive: true });
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}

      return NextResponse.json({ ok: true, tokenStored: true });
    }

    const account = multi.accounts.find((acc) => acc.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const autoLogin = body?.autoLogin !== false;

    if (mode === "token") {
      const token = typeof body?.token === "string" ? body.token.trim() : "";
      if (!token) {
        return NextResponse.json({ error: "缺少 token" }, { status: 400 });
      }
      const accountType = body?.accountType === "bot" ? "bot" : "selfbot";
      account.token = token;
      account.type = accountType;
      if (autoLogin) {
        account.loginRequested = true;
        account.loginNonce = Date.now();
        await writeStatus(account.id, "pending", "正在登录...");
      }
      await saveMultiConfig(multi);
      try {
        await fs.mkdir(path.dirname(triggerFile), { recursive: true });
        await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
      } catch {}
      return NextResponse.json({ ok: true, loginState: autoLogin ? "pending" : "idle" });
    }

    if (account.type === "bot") {
      return NextResponse.json({ error: "机器人账号仅支持 Token 登录" }, { status: 400 });
    }

    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const totpSecret = typeof body?.totpSecret === "string" ? body.totpSecret.trim() : undefined;

    if (!email || !password) {
      return NextResponse.json({ error: "缺少邮箱或密码" }, { status: 400 });
    }

    await fs.mkdir(path.dirname(loginRequestFile), { recursive: true });
    try {
      await fs.access(loginRequestFile);
      return NextResponse.json({ error: "已有登录请求处理中，请稍后" }, { status: 409 });
    } catch {}

    const requestId = randomUUID();
    await fs.writeFile(
      loginRequestFile,
      JSON.stringify(
        {
          id: requestId,
          action: "password",
          params: { email, password, totpSecret },
          createdAt: Date.now(),
        },
        null,
        2,
      ),
    );

    const response = await waitForLoginResponse(requestId, 120000);
    if (!response) {
      return NextResponse.json({ error: "登录请求超时" }, { status: 504 });
    }

    if (!response.success) {
      const detail = response?.result?.message || response?.message;
      const error =
        response?.error && detail ? `${response.error}: ${detail}` : response?.error || detail || "登录失败";
      return NextResponse.json({ error }, { status: 400 });
    }

    const token = response?.result?.token;
    if (!token) {
      return NextResponse.json({ error: "登录失败，未获取到 Token" }, { status: 500 });
    }

    account.token = token;
    account.type = "selfbot";
    account.discordLogin = { email, password, totpSecret };
    if (autoLogin) {
      account.loginRequested = true;
      account.loginNonce = Date.now();
      await writeStatus(account.id, "pending", "正在登录...");
    }
    await saveMultiConfig(multi);
    try {
      await fs.mkdir(path.dirname(triggerFile), { recursive: true });
      await fs.writeFile(triggerFile, Date.now().toString(), "utf-8");
    } catch {}

    return NextResponse.json({ ok: true, tokenStored: true, loginState: autoLogin ? "pending" : "idle" });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
