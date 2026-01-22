import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Telegram 状态文件路径
const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");

function resolveClientAccountId(account: AccountConfig, telegramAccountId?: string) {
  const candidates = account.telegramConfig?.accounts || [];
  const target =
    (telegramAccountId
      ? candidates.find((acc) => acc.id === telegramAccountId)
      : candidates.find((acc) => acc.type === "client" && acc.enabled !== false)) || null;

  return target?.id || account.id;
}

async function readTelegramStatus(): Promise<Record<string, any>> {
  try {
    const content = await fs.readFile(telegramStatusFile, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
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

    // 从状态文件读取状态
    const statusData = await readTelegramStatus();
    const status = statusData[clientAccountId];

    if (!status) {
      return NextResponse.json({ state: "idle", message: "未连接" });
    }

    return NextResponse.json({
      state: status.state || "idle",
      message: status.message || (status.state === "online" ? "已连接" : "未连接"),
      userInfo: status.userInfo,
    });
  } catch (e: any) {
    return NextResponse.json(
      { state: "error", message: String(e?.message || e) },
      { status: 500 },
    );
  }
}
