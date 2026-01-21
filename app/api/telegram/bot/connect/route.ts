import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, saveMultiConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 验证 Telegram Bot Token 是否有效
 */
async function verifyTelegramBotToken(token: string): Promise<{ success: boolean; message: string; userInfo?: any }> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();

    if (data.ok && data.result) {
      return {
        success: true,
        message: '连接成功',
        userInfo: data.result,
      };
    } else {
      return {
        success: false,
        message: data.description || '验证失败',
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: `网络错误: ${error.message || String(error)}`,
    };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = body?.accountId as string | undefined;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    // 检查是否配置了 Telegram Bot Token
    if (!account.telegramBotToken || account.telegramBotToken.trim() === '') {
      return NextResponse.json({
        state: 'error',
        message: '未配置 Telegram Bot Token',
      }, { status: 400 });
    }

    // 验证 Token
    const result = await verifyTelegramBotToken(account.telegramBotToken);

    if (result.success) {
      return NextResponse.json({
        state: 'online',
        message: `连接成功: @${result.userInfo?.username || result.userInfo?.first_name || 'Bot'}`,
        userInfo: result.userInfo,
      });
    } else {
      return NextResponse.json({
        state: 'error',
        message: result.message,
      }, { status: 400 });
    }

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
