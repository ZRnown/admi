import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const multi = await getMultiConfig();

    // 收集所有账号的Telegram会话信息
    const sessions: any[] = [];

    for (const account of multi.accounts) {
      const telegramConfig = account.telegramConfig;
      if (!telegramConfig || !telegramConfig.accounts) continue;

      for (const tgAccount of telegramConfig.accounts) {
        if (tgAccount.type !== 'client') continue; // 只处理客户端账号

        // TODO: 通过IPC获取实际的会话信息
        // 目前返回模拟数据
        sessions.push({
          id: tgAccount.id,
          accountId: account.id,
          accountName: account.name,
          telegramAccountName: tgAccount.name,
          type: tgAccount.type,
          hasSessionFile: tgAccount.sessionPath ? true : false,
          hasSessionString: tgAccount.sessionString ? true : false,
          sessionPath: tgAccount.sessionPath,
          lastModified: new Date().toISOString(), // 模拟数据
          size: 1024, // 模拟数据
        });
      }
    }

    return NextResponse.json({
      success: true,
      sessions: sessions
    });

  } catch (e: any) {
    return NextResponse.json(
      {
        success: false,
        error: String(e?.message || e)
      },
      { status: 500 }
    );
  }
}
