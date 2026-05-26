import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";
import { getEnv } from "@/src/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = body?.accountId as string | undefined;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account: AccountConfig | undefined = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    // 检查账号是否有Telegram配置
    const telegramConfig = account.telegramConfig;
    if (!telegramConfig || !telegramConfig.accounts || telegramConfig.accounts.length === 0) {
      return NextResponse.json({ error: "账号没有Telegram配置" }, { status: 400 });
    }

    // 这里需要与telegram_bridge进程通信
    // 目前先返回模拟数据，实际实现需要IPC通信
    try {
      // TODO: 通过IPC调用telegram_bridge的getChannels方法
      const channels = [
        {
          id: "-1001234567890",
          title: "测试频道",
          type: "channel" as const,
          username: "test_channel"
        },
        {
          id: "-1001987654321",
          title: "测试群组",
          type: "group" as const
        }
      ];

      return NextResponse.json({
        success: true,
        channels: channels
      });

    } catch (bridgeError: any) {
      return NextResponse.json(
        {
          error: `Telegram Bridge通信失败: ${bridgeError?.message || String(bridgeError)}`
        },
        { status: 500 }
      );
    }

  } catch (e: any) {
    return NextResponse.json(
      { error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
