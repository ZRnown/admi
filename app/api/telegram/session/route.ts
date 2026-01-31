import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig, saveMultiConfig, type AccountConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get('accountId');
    const telegramAccountId = searchParams.get('telegramAccountId');
    const useLibrary = searchParams.get('useLibrary') === '1' || !accountId;

    if ((!accountId && !useLibrary) || !telegramAccountId) {
      return NextResponse.json({
        error: "缺少必要参数: accountId, telegramAccountId"
      }, { status: 400 });
    }

    const multi = await getMultiConfig();
    if (useLibrary) {
      const tgAccount = (multi.telegramAccounts || []).find((acc) => acc.id === telegramAccountId);
      if (!tgAccount) {
        return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
      }
      const sessionInfo = {
        id: tgAccount.id,
        accountId: tgAccount.id,
        accountName: "全局账号库",
        telegramAccountName: tgAccount.name,
        type: tgAccount.type,
        hasSessionFile: tgAccount.sessionPath ? true : false,
        hasSessionString: tgAccount.sessionString ? true : false,
        sessionPath: tgAccount.sessionPath,
        lastModified: new Date().toISOString(),
        size: tgAccount.sessionString ? tgAccount.sessionString.length : 0,
      };
      return NextResponse.json({
        success: true,
        session: sessionInfo
      });
    }

    const account: AccountConfig | undefined = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const telegramConfig = account.telegramConfig;
    if (!telegramConfig || !telegramConfig.accounts) {
      return NextResponse.json({ error: "账号没有Telegram配置" }, { status: 400 });
    }

    const tgAccount = telegramConfig.accounts.find(acc => acc.id === telegramAccountId);
    if (!tgAccount) {
      return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
    }

    // TODO: 通过IPC获取实际的会话信息
    // 目前返回模拟数据
    const sessionInfo = {
      id: tgAccount.id,
      accountId: account.id,
      accountName: account.name,
      telegramAccountName: tgAccount.name,
      type: tgAccount.type,
      hasSessionFile: tgAccount.sessionPath ? true : false,
      hasSessionString: tgAccount.sessionString ? true : false,
      sessionPath: tgAccount.sessionPath,
      lastModified: new Date().toISOString(),
      size: tgAccount.sessionString ? tgAccount.sessionString.length : 0,
    };

    return NextResponse.json({
      success: true,
      session: sessionInfo
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

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action as string | undefined;
    const accountId = body?.accountId as string | undefined;
    const telegramAccountId = body?.telegramAccountId as string | undefined;
    const useLibrary = body?.useLibrary === true || !accountId;

    if (!action || (!accountId && !useLibrary) || !telegramAccountId) {
      return NextResponse.json({
        error: "缺少必要参数: action, accountId, telegramAccountId"
      }, { status: 400 });
    }

    const multi = await getMultiConfig();
    if (useLibrary) {
      const tgAccount = (multi.telegramAccounts || []).find((acc) => acc.id === telegramAccountId);
      if (!tgAccount) {
        return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
      }

      if (action === 'import') {
        const sessionData = body?.sessionData as string | undefined;
        if (!sessionData) {
          return NextResponse.json({ error: "缺少sessionData参数" }, { status: 400 });
        }

        tgAccount.sessionString = sessionData;
        await saveMultiConfig(multi);

        return NextResponse.json({
          success: true,
          message: "会话导入成功"
        });

      } else if (action === 'export') {
        if (!tgAccount.sessionString) {
          return NextResponse.json({ error: "没有可导出的会话数据" }, { status: 404 });
        }

        return NextResponse.json({
          success: true,
          sessionData: tgAccount.sessionString
        });

      } else if (action === 'delete') {
        tgAccount.sessionString = undefined;
        tgAccount.sessionPath = undefined;

        await saveMultiConfig(multi);

        return NextResponse.json({
          success: true,
          message: "会话删除成功"
        });

      } else {
        return NextResponse.json({ error: `不支持的操作: ${action}` }, { status: 400 });
      }
    }

    const account: AccountConfig | undefined = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    const telegramConfig = account.telegramConfig;
    if (!telegramConfig || !telegramConfig.accounts) {
      return NextResponse.json({ error: "账号没有Telegram配置" }, { status: 400 });
    }

    const tgAccount = telegramConfig.accounts.find(acc => acc.id === telegramAccountId);
    if (!tgAccount) {
      return NextResponse.json({ error: "Telegram账号不存在" }, { status: 404 });
    }

    // 处理不同的操作
    if (action === 'import') {
      const sessionData = body?.sessionData as string | undefined;
      if (!sessionData) {
        return NextResponse.json({ error: "缺少sessionData参数" }, { status: 400 });
      }

      // TODO: 通过IPC导入会话数据
      // 更新配置中的sessionString
      tgAccount.sessionString = sessionData;

      await saveMultiConfig(multi);

      return NextResponse.json({
        success: true,
        message: "会话导入成功"
      });

    } else if (action === 'export') {
      // TODO: 通过IPC导出会话数据
      if (!tgAccount.sessionString) {
        return NextResponse.json({ error: "没有可导出的会话数据" }, { status: 404 });
      }

      return NextResponse.json({
        success: true,
        sessionData: tgAccount.sessionString
      });

    } else if (action === 'delete') {
      // TODO: 通过IPC删除会话数据
      tgAccount.sessionString = undefined;
      tgAccount.sessionPath = undefined;

      await saveMultiConfig(multi);

      return NextResponse.json({
        success: true,
        message: "会话删除成功"
      });

    } else {
      return NextResponse.json({ error: `不支持的操作: ${action}` }, { status: 400 });
    }

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
