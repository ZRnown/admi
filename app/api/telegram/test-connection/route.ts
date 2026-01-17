import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, type AccountConfig } from "@/src/config";

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
      // 查找指定的Telegram账号
      const tgAccountId = body?.telegramAccountId as string | undefined;
      const tgAccount = tgAccountId
        ? telegramConfig.accounts.find(acc => acc.id === tgAccountId)
        : telegramConfig.accounts[0];

      if (!tgAccount) {
        return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
      }

      // TODO: 通过IPC调用telegram_bridge的连接测试方法
      // 模拟连接测试结果
      const testResult = {
        success: true,
        message: "连接测试成功",
        userInfo: {
          id: 123456789,
          firstName: "Test",
          lastName: "User",
          username: "testuser"
        }
      };

      return NextResponse.json(testResult);

    } catch (bridgeError: any) {
      return NextResponse.json(
        {
          success: false,
          message: `连接测试失败: ${bridgeError?.message || String(bridgeError)}`
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
