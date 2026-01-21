import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";
import { getBridgeClient } from "@/app/api/telegram/_lib/bridgeClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveClientAccountId(account: AccountConfig, telegramAccountId?: string) {
  const candidates = account.telegramConfig?.accounts || [];
  const target =
    (telegramAccountId
      ? candidates.find((acc) => acc.id === telegramAccountId)
      : candidates.find((acc) => acc.type === "client" && acc.enabled !== false)) || null;

  return target?.id || account.id;
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

    const clientAccountId = resolveClientAccountId(account, telegramAccountId);
    const bridgeClient = await getBridgeClient();
    const status = await bridgeClient.getClientStatus(clientAccountId);

    if (!status) {
      return NextResponse.json({ state: "idle", message: "未连接" });
    }

    const rawStatus = typeof status.status === "string" ? status.status : String(status.status || "");
    const normalized =
      rawStatus === "connected"
        ? "online"
        : rawStatus === "connecting"
          ? "connecting"
          : rawStatus === "error"
            ? "error"
            : "idle";

    return NextResponse.json({
      state: normalized,
      message: status.error_message || (normalized === "online" ? "已连接" : "未连接"),
      userInfo: status.user_info,
    });
  } catch (e: any) {
    return NextResponse.json(
      { state: "error", message: String(e?.message || e) },
      { status: 500 },
    );
  }
}
