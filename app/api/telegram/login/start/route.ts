import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { getMultiConfig, saveMultiConfig, type AccountConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loginRequestFile = path.resolve(process.cwd(), ".data", "telegram_login_request.json");
const loginResponseFile = path.resolve(process.cwd(), ".data", "telegram_login_response.json");

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

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }
    if (!phoneNumber || !apiId || !apiHash) {
      return NextResponse.json({ error: "缺少 phoneNumber / apiId / apiHash" }, { status: 400 });
    }

    const multi = await getMultiConfig();
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
        name: "Telegram Client",
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

    const response = await waitForLoginResponse(requestId, 20000);
    if (!response) {
      return NextResponse.json({ error: "登录请求超时" }, { status: 504 });
    }

    if (!response.success) {
      return NextResponse.json({ error: response.error || response?.result?.message || "登录失败" }, { status: 400 });
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
