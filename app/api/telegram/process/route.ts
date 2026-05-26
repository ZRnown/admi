import { NextRequest, NextResponse } from "next/server";
import { telegramBridgeManager } from "@/src/processManager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET - 获取进程状态
export async function GET(req: NextRequest) {
  try {
    const status = telegramBridgeManager.getStatus();

    return NextResponse.json({
      success: true,
      isRunning: telegramBridgeManager.isRunning(),
      processInfo: status
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

// POST - 控制进程（启动/停止/重启）
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action as string | undefined;

    if (!action) {
      return NextResponse.json({ error: "缺少 action 参数" }, { status: 400 });
    }

    let result;

    switch (action) {
      case 'start':
        result = await telegramBridgeManager.start();
        break;

      case 'stop':
        result = await telegramBridgeManager.stop();
        break;

      case 'restart':
        result = await telegramBridgeManager.restart();
        break;

      default:
        return NextResponse.json({ error: `不支持的操作: ${action}` }, { status: 400 });
    }

    return NextResponse.json(result);

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
