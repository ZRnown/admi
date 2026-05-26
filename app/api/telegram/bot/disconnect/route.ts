import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, saveMultiConfig } from "@/src/config";
import { getBridgeClient } from "../../_lib/bridgeClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = body?.accountId as string | undefined;
    const telegramAccountId = body?.telegramAccountId as string | undefined;
    const useLibrary = body?.useLibrary === true || !accountId;

    if (!accountId && !useLibrary) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    if (useLibrary) {
      if (!telegramAccountId) {
        return NextResponse.json({ error: "缺少 telegramAccountId" }, { status: 400 });
      }
      const target = (multi.telegramAccounts || []).find((acc) => acc.id === telegramAccountId);
      if (!target) {
        return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
      }
      target.enabled = false;
      await saveMultiConfig(multi);

      try {
        const client = await getBridgeClient();
        await client.disconnectBot(telegramAccountId);
      } catch (e) {
        console.log("[Telegram Bot Disconnect] Bridge disconnect error:", e);
      }

      return NextResponse.json({
        state: 'idle',
        message: '已断开',
      });
    }

    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    // 保存 enabled: false 到配置
    const botStatusId = telegramAccountId || `${accountId}_bot`;
    if (account.telegramConfig?.accounts) {
      const target = account.telegramConfig.accounts.find(a => a.id === botStatusId);
      if (target) {
        target.enabled = false;
        await saveMultiConfig(multi);
      }
    }

    // 通知 Telegram Bridge 断开连接
    try {
      const client = await getBridgeClient();
      await client.disconnectBot(botStatusId);
    } catch (e) {
      // 忽略断开错误，可能 Bridge 未运行
      console.log("[Telegram Bot Disconnect] Bridge disconnect error:", e);
    }

    return NextResponse.json({
      state: 'idle',
      message: '已断开',
    });

  } catch (e: any) {
    return NextResponse.json(
      {
        state: 'error',
        message: String(e?.message || e),
      },
      { status: 500 }
    );
  }
}
