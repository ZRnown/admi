import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = body?.accountId as string | undefined;
    const telegramAccountId = body?.telegramAccountId as string | undefined;
    const chatId = body?.chatId as string | undefined;
    const message = body?.message as string | undefined;

    if (!accountId || !telegramAccountId || !chatId || !message) {
      return NextResponse.json({
        error: "缺少必要参数: accountId, telegramAccountId, chatId, message"
      }, { status: 400 });
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

    // 验证Telegram账号存在
    const tgAccount = telegramConfig.accounts.find(acc => acc.id === telegramAccountId);
    if (!tgAccount) {
      return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
    }

    // 这里需要与telegram_bridge进程通信
    // 目前先返回模拟数据，实际实现需要IPC通信
    try {
      // TODO: 通过IPC调用telegram_bridge的sendMessage方法
      const sendResult = {
        success: true,
        message: "测试消息发送成功",
        messageId: 12345
      };

      return NextResponse.json(sendResult);

    } catch (bridgeError: any) {
      return NextResponse.json(
        {
          success: false,
          message: `发送测试消息失败: ${bridgeError?.message || String(bridgeError)}`
        },
        { status: 500 }
      );
    }

  } catch (e: any) {
    return NextResponse.json(
      {
        success: false,
        message: String(e?.message || e)
      },
      { status: 500 }
    );
  }
}
