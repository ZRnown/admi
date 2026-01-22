import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, saveMultiConfig, type AccountConfig } from "@/src/config";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 状态文件路径
const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");

function resolveClientAccountId(account: AccountConfig, telegramAccountId?: string) {
  const candidates = account.telegramConfig?.accounts || [];
  const target =
    (telegramAccountId
      ? candidates.find((acc) => acc.id === telegramAccountId)
      : candidates.find((acc) => acc.type === "client" && acc.enabled !== false)) || null;
  return target?.id || account.id;
}

async function writeTelegramStatus(accountId: string, state: string, message: string) {
  try {
    let statusData: Record<string, any> = {};
    try {
      const content = await fs.readFile(telegramStatusFile, "utf-8");
      statusData = JSON.parse(content);
    } catch {
      // 文件不存在或解析失败
    }
    statusData[accountId] = { state, message };
    await fs.mkdir(path.dirname(telegramStatusFile), { recursive: true });
    await fs.writeFile(telegramStatusFile, JSON.stringify(statusData, null, 2));
  } catch {
    // 忽略错误
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

    // 保存 enabled: false 到配置
    if (account.telegramConfig?.accounts) {
      const target = account.telegramConfig.accounts.find(a => a.id === clientAccountId);
      if (target) {
        target.enabled = false;
        await saveMultiConfig(multi);
      }
    }

    // 更新状态文件为已断开
    await writeTelegramStatus(clientAccountId, "idle", "已断开");

    return NextResponse.json({ state: "idle", message: "已断开" });
  } catch (e: any) {
    return NextResponse.json(
      { state: "error", message: String(e?.message || e) },
      { status: 500 },
    );
  }
}
