import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, saveMultiConfig, type AccountConfig } from "@/src/config";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Telegram 状态文件路径
const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");
const triggerFile = path.resolve(process.cwd(), ".data", "trigger_reload");

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

async function markTelegramAccountsIdle(accountIds: string[], message: string) {
  if (!accountIds.length) return;
  try {
    let statusData: Record<string, any> = {};
    try {
      const content = await fs.readFile(telegramStatusFile, "utf-8");
      statusData = JSON.parse(content);
    } catch {
      // ignore
    }
    for (const id of accountIds) {
      if (!id) continue;
      const current = statusData[id] || {};
      statusData[id] = { ...current, state: "idle", message };
    }
    await fs.mkdir(path.dirname(telegramStatusFile), { recursive: true });
    await fs.writeFile(telegramStatusFile, JSON.stringify(statusData, null, 2));
  } catch {
    // 忽略错误
  }
}

function disableOppositeTelegramAccounts(
  account: AccountConfig,
  role: "listener" | "sender" | undefined,
): string[] {
  if (!account.telegramConfig?.accounts) return [];
  const disabledIds: string[] = [];
  for (const entry of account.telegramConfig.accounts) {
    if (!entry || entry.type !== "client") continue;
    if (role) {
      if (entry.role !== role) continue;
    } else if (entry.role) {
      // 无角色时不影响已有角色账号
      continue;
    }
    if (entry.enabled !== false) {
      entry.enabled = false;
      disabledIds.push(entry.id);
    }
  }
  return disabledIds;
}

async function triggerBotReload() {
  try {
    await fs.mkdir(path.dirname(triggerFile), { recursive: true });
    await fs.writeFile(triggerFile, Date.now().toString());
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
    const telegramAccountId = body?.telegramAccountId as string | undefined;
    const role = body?.role === "listener" || body?.role === "sender" ? body.role : undefined;
    const useLibrary = body?.useLibrary === true || !accountId;

    if (!accountId && !useLibrary) {
      return NextResponse.json({ error: "缺少 accountId" }, { status: 400 });
    }

    const multi = await getMultiConfig();
    if (useLibrary) {
      if (!telegramAccountId) {
        return NextResponse.json({ error: "缺少 telegramAccountId" }, { status: 400 });
      }
      const tgAccount = (multi.telegramAccounts || []).find((acc) => acc.id === telegramAccountId);
      if (!tgAccount) {
        return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
      }
      const tokenToUse = tgAccount.token || "";
      if (!tokenToUse || tokenToUse.trim() === '') {
        return NextResponse.json({ state: 'error', message: '未配置 Telegram Bot Token' }, { status: 400 });
      }

      const result = await verifyTelegramBotToken(tokenToUse);
      if (result.success) {
        tgAccount.type = "bot";
        tgAccount.token = tokenToUse;
        tgAccount.name = result.userInfo?.username || tgAccount.name || 'Telegram Bot';
        tgAccount.enabled = true;
        await saveMultiConfig(multi);

        await writeTelegramStatus(telegramAccountId, "online", `连接成功: @${result.userInfo?.username || 'Bot'}`, result.userInfo);
        await triggerBotReload();

        return NextResponse.json({
          state: 'online',
          message: `连接成功: @${result.userInfo?.username || result.userInfo?.first_name || 'Bot'}`,
          userInfo: result.userInfo,
        });
      } else {
        await writeTelegramStatus(telegramAccountId, "error", result.message);
        return NextResponse.json({ state: 'error', message: result.message }, { status: 400 });
      }
    }

    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const botStatusId = telegramAccountId || `${accountId}_bot`;
    const configuredBot = account.telegramConfig?.accounts?.find((acc) => acc.id === botStatusId);
    const tokenToUse = telegramAccountId ? configuredBot?.token || "" : configuredBot?.token || account.telegramBotToken || "";

    // 检查是否配置了 Telegram Bot Token
    if (!tokenToUse || tokenToUse.trim() === '') {
      return NextResponse.json({
        state: 'error',
        message: '未配置 Telegram Bot Token',
      }, { status: 400 });
    }

    // 验证 Token
    const result = await verifyTelegramBotToken(tokenToUse);

    if (result.success) {
      // 保存 enabled: true 到配置
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
          token: tokenToUse,
          role,
          enabled: true
        };
        account.telegramConfig.accounts.push(botAccount);
      } else {
        // 更新 token 和名称（修复缓存问题）
        botAccount.token = tokenToUse;
        botAccount.name = result.userInfo?.username || 'Telegram Bot';
        if (role) {
          botAccount.role = role;
        }
        botAccount.enabled = true;
      }
      const disabledIds = disableOppositeTelegramAccounts(account, role);
      await saveMultiConfig(multi);

      // 写入状态到文件
      await writeTelegramStatus(botStatusId, "online", `连接成功: @${result.userInfo?.username || 'Bot'}`, result.userInfo);
      if (disabledIds.length > 0) {
        await markTelegramAccountsIdle(disabledIds, "已切换为 Bot");
      }

      // 触发 Bot 进程重新加载配置
      await triggerBotReload();

      return NextResponse.json({
        state: 'online',
        message: `连接成功: @${result.userInfo?.username || result.userInfo?.first_name || 'Bot'}`,
        userInfo: result.userInfo,
      });
    } else {
      // 写入错误状态
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
