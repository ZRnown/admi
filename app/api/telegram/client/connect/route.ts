import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, saveMultiConfig, type AccountConfig } from "@/src/config";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 状态文件和触发文件路径
const telegramStatusFile = path.resolve(process.cwd(), ".data", "telegram_status.json");
const triggerFile = path.resolve(process.cwd(), ".data", "trigger_reload");

function resolveClientAccountId(account: AccountConfig, telegramAccountId?: string) {
  const candidates = account.telegramConfig?.accounts || [];
  const target =
    (telegramAccountId
      ? candidates.find((acc) => acc.id === telegramAccountId)
      : candidates.find((acc) => acc.type === "client" && acc.enabled === true)) || null;

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

async function triggerBotReload() {
  try {
    await fs.mkdir(path.dirname(triggerFile), { recursive: true });
    await fs.writeFile(triggerFile, Date.now().toString());
  } catch {
    // 忽略错误
  }
}

async function waitForStatus(accountId: string, maxWaitMs: number = 10000): Promise<any> {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const statusData = await readTelegramStatus();
    const status = statusData[accountId];
    if (status && (status.state === "online" || status.state === "error")) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return null;
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

    // 保存 enabled 状态到配置
    if (!account.telegramConfig) {
      account.telegramConfig = { accounts: [], mappings: [], enableTelegramForward: false };
    }
    if (!account.telegramConfig.accounts) {
      account.telegramConfig.accounts = [];
    }

    const candidates = account.telegramConfig.accounts;
    let targetAccount = candidates.find((acc) => acc.id === clientAccountId);

    if (!targetAccount) {
      // Legacy 模式：创建一个显式条目以保存 enabled 状态
      if (clientAccountId === account.id) {
        targetAccount = {
          id: account.id,
          name: "Telegram Client",
          type: "client" as const,
          token: "",
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          sessionPath: account.telegramSessionPath,
          sessionString: account.telegramSessionString,
          enabled: true
        };
        account.telegramConfig.accounts.push(targetAccount);
      }
    } else {
      targetAccount.enabled = true;
    }

    // 保存配置到磁盘（确保下次重启自动登录）
    await saveMultiConfig(multi);

    // 检查是否有必要的配置
    const clientAccount = candidates.find((acc) => acc.id === clientAccountId) || {
      apiId: account.telegramApiId,
      apiHash: account.telegramApiHash,
      sessionPath: account.telegramSessionPath,
      sessionString: account.telegramSessionString,
    };

    if (!clientAccount.apiId || !clientAccount.apiHash) {
      return NextResponse.json(
        { state: "error", message: "缺少 Telegram API ID 或 API Hash" },
        { status: 400 },
      );
    }
    if (!clientAccount.sessionString && !clientAccount.sessionPath) {
      return NextResponse.json(
        { state: "error", message: "缺少 Telegram Session（文件或字符串）" },
        { status: 400 },
      );
    }

    // 触发 Bot 进程重新加载配置
    await triggerBotReload();

    // 等待连接状态更新
    const status = await waitForStatus(clientAccountId, 15000);

    if (status) {
      if (status.state === "online") {
        const userInfo = status.userInfo || {};
        const name = userInfo.username
          ? `@${userInfo.username}`
          : `${userInfo.firstName || ""} ${userInfo.lastName || ""}`.trim();
        return NextResponse.json({
          state: "online",
          message: name ? `连接成功: ${name}` : "连接成功",
          userInfo: status.userInfo,
        });
      } else {
        return NextResponse.json({
          state: status.state,
          message: status.message || "连接失败",
        });
      }
    }

    // 超时，返回当前状态
    const currentStatus = await readTelegramStatus();
    const currentAccountStatus = currentStatus[clientAccountId];

    if (currentAccountStatus) {
      return NextResponse.json({
        state: currentAccountStatus.state || "connecting",
        message: currentAccountStatus.message || "正在连接...",
        userInfo: currentAccountStatus.userInfo,
      });
    }

    return NextResponse.json({
      state: "connecting",
      message: "正在连接，请稍后刷新状态",
    });
  } catch (e: any) {
    return NextResponse.json(
      { state: "error", message: String(e?.message || e) },
      { status: 500 },
    );
  }
}
