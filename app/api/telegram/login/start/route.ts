import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig, saveMultiConfig, type AccountConfig } from "@/src/config";
import { resolveDataPath } from "@/src/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginRequestFile = resolveDataPath("telegram_login_request.json");
const loginResponseFile = resolveDataPath("telegram_login_response.json");
const loginDebugFile = resolveDataPath("telegram_login_debug.jsonl");

async function appendLoginDebug(event: string, payload: Record<string, any>) {
  try {
    await fs.mkdir(path.dirname(loginDebugFile), { recursive: true });
    await fs.appendFile(
      loginDebugFile,
      JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...payload,
      }) + "\n",
    );
  } catch {}
}

async function waitForLoginResponse(requestId: string, maxWaitMs = 15000): Promise<any | null> {
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

function resolveClientAccount(account: AccountConfig, telegramAccountId?: string) {
  if (telegramAccountId) return telegramAccountId;
  const candidates = account.telegramConfig?.accounts || [];
  const target = candidates.find((acc) => acc.type === "client" && acc.enabled !== false);
  return target?.id || account.id;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = typeof body?.accountId === "string" ? body.accountId : "";
    const telegramAccountId = typeof body?.telegramAccountId === "string" ? body.telegramAccountId : undefined;
    const useLibrary = body?.useLibrary === true || !accountId;
    const phoneNumber = typeof body?.phoneNumber === "string" ? body.phoneNumber.trim() : "";
    const apiIdRaw = body?.apiId;
    const apiHash = typeof body?.apiHash === "string" ? body.apiHash.trim() : "";
    const twoFactorPassword = typeof body?.twoFactorPassword === "string" ? body.twoFactorPassword : undefined;

    const apiId =
      typeof apiIdRaw === "number"
        ? apiIdRaw
        : typeof apiIdRaw === "string" && apiIdRaw.trim() && !isNaN(Number(apiIdRaw))
          ? Number(apiIdRaw)
          : undefined;

    if (!accountId && !useLibrary) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!phoneNumber || !apiId || !apiHash) {
      return NextResponse.json({ error: "缺少 phoneNumber / apiId / apiHash" }, { status: 400 });
    }

    await appendLoginDebug("request", {
      useLibrary,
      accountId: accountId || undefined,
      telegramAccountId,
      phoneSuffix: phoneNumber.slice(-4),
      apiIdPresent: Boolean(apiId),
      apiHashLength: apiHash.length,
    });

    const multi = await getMultiConfig();
    if (useLibrary) {
      if (!telegramAccountId) {
        return NextResponse.json({ error: "缺少 telegramAccountId" }, { status: 400 });
      }
      if (!multi.telegramAccounts) multi.telegramAccounts = [];
      let targetAccount = multi.telegramAccounts.find((acc) => acc.id === telegramAccountId);
      if (!targetAccount) {
        return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
      } else {
        targetAccount.type = "client";
        targetAccount.apiId = apiId;
        targetAccount.apiHash = apiHash;
        (targetAccount as any).phoneNumber = phoneNumber;
        (targetAccount as any).twoFactorPassword = twoFactorPassword;
        targetAccount.sessionType = "string";
        targetAccount.enabled = true;
      }
      await saveMultiConfig(multi);
      const requestId = randomUUID();
      await fs.mkdir(path.dirname(loginRequestFile), { recursive: true });
      try {
        await fs.access(loginRequestFile);
        return NextResponse.json({ error: "已有登录请求处理中，请稍后" }, { status: 409 });
      } catch {}

      await fs.writeFile(
        loginRequestFile,
        JSON.stringify(
          {
            id: requestId,
            action: "start",
            params: {
              phoneNumber,
              apiId,
              apiHash,
              proxyUrl: (targetAccount as any).proxyUrl,
            },
            createdAt: Date.now(),
          },
          null,
          2,
        ),
      );

      const response = await waitForLoginResponse(requestId, 40000);
      await appendLoginDebug("response", {
        requestId,
        telegramAccountId,
        success: response?.success === true,
        error: response?.error,
        resultError: response?.result?.error,
        resultMessage: response?.result?.message,
      });
      if (!response) {
        return NextResponse.json({ error: "登录请求超时" }, { status: 504 });
      }

      if (!response.success) {
        const detail = response?.result?.message || response?.message;
        const error =
          response?.error && detail ? `${response.error}: ${detail}` : response?.error || detail || "登录失败";
        return NextResponse.json({ error }, { status: 400 });
      }

      const loginId = response?.result?.loginId;
      if (!loginId) {
        return NextResponse.json({ error: "登录失败，未返回 loginId" }, { status: 500 });
      }

      return NextResponse.json({ success: true, loginId, telegramAccountId });
    }

    const account = multi.accounts.find((a) => a.id === accountId);
    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const clientAccountId = resolveClientAccount(account, telegramAccountId);
    if (!account.telegramConfig) {
      account.telegramConfig = { accounts: [], mappings: [], enableTelegramForward: false };
    }
    if (!account.telegramConfig.accounts) {
      account.telegramConfig.accounts = [];
    }

      let targetAccount = account.telegramConfig.accounts.find((acc) => acc.id === clientAccountId);
      if (!targetAccount) {
        targetAccount = {
          id: clientAccountId,
          name: "",
          type: "client",
        token: "",
        apiId,
        apiHash,
        phoneNumber,
        twoFactorPassword,
        sessionType: "string",
        enabled: true,
      } as any;
      account.telegramConfig.accounts.push(targetAccount);
    } else {
      targetAccount.type = "client";
      targetAccount.apiId = apiId;
      targetAccount.apiHash = apiHash;
      (targetAccount as any).phoneNumber = phoneNumber;
      (targetAccount as any).twoFactorPassword = twoFactorPassword;
      targetAccount.sessionType = "string";
      targetAccount.enabled = true;
    }

    await saveMultiConfig(multi);

    const requestId = randomUUID();
    await fs.mkdir(path.dirname(loginRequestFile), { recursive: true });
    try {
      await fs.access(loginRequestFile);
      return NextResponse.json({ error: "已有登录请求处理中，请稍后" }, { status: 409 });
    } catch {}

    await fs.writeFile(
      loginRequestFile,
      JSON.stringify(
        {
          id: requestId,
          action: "start",
          params: {
            phoneNumber,
            apiId,
            apiHash,
            proxyUrl: (targetAccount as any).proxyUrl || account.proxyUrl,
          },
          createdAt: Date.now(),
        },
        null,
        2,
      ),
    );

    const response = await waitForLoginResponse(requestId, 40000);
    await appendLoginDebug("response", {
      requestId,
      accountId,
      telegramAccountId: clientAccountId,
      success: response?.success === true,
      error: response?.error,
      resultError: response?.result?.error,
      resultMessage: response?.result?.message,
    });
    if (!response) {
      return NextResponse.json({ error: "登录请求超时" }, { status: 504 });
    }

    if (!response.success) {
      const detail = response?.result?.message || response?.message;
      const error =
        response?.error && detail ? `${response.error}: ${detail}` : response?.error || detail || "登录失败";
      return NextResponse.json({ error }, { status: 400 });
    }

    const loginId = response?.result?.loginId;
    if (!loginId) {
      return NextResponse.json({ error: "登录失败，未返回 loginId" }, { status: 500 });
    }

    return NextResponse.json({ success: true, loginId, telegramAccountId: clientAccountId });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
