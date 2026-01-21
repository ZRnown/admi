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
    const result = await bridgeClient.disconnectClient(clientAccountId);

    if (result?.success) {
      return NextResponse.json({ state: "idle", message: "已断开" });
    }

    return NextResponse.json(
      { state: "error", message: result?.message || "断开失败" },
      { status: 400 },
    );
  } catch (e: any) {
    return NextResponse.json(
      { state: "error", message: String(e?.message || e) },
      { status: 500 },
    );
  }
}
