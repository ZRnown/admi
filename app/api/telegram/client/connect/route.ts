import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";
import { getBridgeClient } from "@/app/api/telegram/_lib/bridgeClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveClientAccount(account: AccountConfig, telegramAccountId?: string) {
  const candidates = account.telegramConfig?.accounts || [];
  const target =
    (telegramAccountId
      ? candidates.find((acc) => acc.id === telegramAccountId)
      : candidates.find((acc) => acc.type === "client" && acc.enabled !== false)) || null;

  if (target) {
    return {
      id: target.id,
      name: target.name || account.name || "Telegram Client",
      type: "client",
      token: target.token || target.apiHash || account.telegramApiHash || "",
      session_path: target.sessionPath || undefined,
      session_string: target.sessionString || undefined,
      api_id: target.apiId || account.telegramApiId,
      api_hash: target.apiHash || account.telegramApiHash,
      proxy_url: target.proxyUrl || account.proxyUrl,
      enabled: target.enabled !== false,
    };
  }

  return {
    id: account.id,
    name: account.name || "Telegram Client",
    type: "client",
    token: account.telegramApiHash || "",
    session_path: account.telegramSessionPath || undefined,
    session_string: account.telegramSessionString || undefined,
    api_id: account.telegramApiId,
    api_hash: account.telegramApiHash,
    proxy_url: account.proxyUrl,
    enabled: true,
  };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = body?.accountId as string | undefined;
    const telegramAccountId = body?.telegramAccountId as string | undefined;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const clientAccount = resolveClientAccount(account, telegramAccountId);
    if (!clientAccount.api_id || !clientAccount.api_hash) {
      return NextResponse.json(
        { state: "error", message: "缺少 Telegram API ID 或 API Hash" },
        { status: 400 },
      );
    }
    if (!clientAccount.session_string && !clientAccount.session_path) {
      return NextResponse.json(
        { state: "error", message: "缺少 Telegram Session（文件或字符串）" },
        { status: 400 },
      );
    }

    const bridgeClient = await getBridgeClient();
    const result = await bridgeClient.connectClient(clientAccount);

    if (result?.success) {
      const user = result.userInfo || {};
      const name = user.username ? `@${user.username}` : `${user.firstName || ""} ${user.lastName || ""}`.trim();
      return NextResponse.json({
        state: "online",
        message: name ? `连接成功: ${name}` : "连接成功",
        userInfo: result.userInfo,
      });
    }

    return NextResponse.json(
      { state: "error", message: result?.message || "连接失败" },
      { status: 400 },
    );
  } catch (e: any) {
    return NextResponse.json(
      { state: "error", message: String(e?.message || e) },
      { status: 500 },
    );
  }
}
