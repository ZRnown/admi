import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, saveMultiConfig } from "@/src/config";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Telegram 状态文件路径
const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");

async function writeTelegramStatus(accountId: string, state: string, message: string, userInfo?: any) {
  try {
    let statusData: Record<string, any> = {};
    try {
      const content = await fs.readFile(telegramStatusFile, "utf-8");
      statusData = JSON.parse(content);
    } catch {
      // 文件不存在或解析失败
    }
    statusData[accountId] = { state, message, userInfo };
    await fs.mkdir(path.dirname(telegramStatusFile), { recursive: true });
    await fs.writeFile(telegramStatusFile, JSON.stringify(statusData, null, 2));
  } catch {
    // 忽略错误
  }
}

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
      // 保存 enabled: true 到配置
      const botStatusId = `${accountId}_bot`;
      if (!account.telegramConfig) {
        account.telegramConfig = { accounts: [], mappings: [], enableTelegramForward: false };
      }
      if (!account.telegramConfig.accounts) {
        account.telegramConfig.accounts = [];
      }

      let botAccount = account.telegramConfig.accounts.find(a => a.id === botStatusId);
      if (!botAccount) {
        botAccount = {
          id: botStatusId,
          name: result.userInfo?.username || 'Telegram Bot',
          type: 'bot' as const,
          token: account.telegramBotToken || '',
          enabled: true
        };
        account.telegramConfig.accounts.push(botAccount);
      } else {
        botAccount.enabled = true;
      }
      await saveMultiConfig(multi);

      // 写入状态到文件
      await writeTelegramStatus(botStatusId, "online", `连接成功: @${result.userInfo?.username || 'Bot'}`, result.userInfo);

      return NextResponse.json({
        state: 'online',
        message: `连接成功: @${result.userInfo?.username || result.userInfo?.first_name || 'Bot'}`,
        userInfo: result.userInfo,
      });
    } else {
      // 写入错误状态
      const botStatusId = `${accountId}_bot`;
      await writeTelegramStatus(botStatusId, "error", result.message);

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
