import { NextRequest, NextResponse } from "next/server";
import { getMultiConfig } from "@/src/config";

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
    const account = multi.accounts.find((a) => a.id === accountId);

    if (!account) {
      return NextResponse.json({ error: "账号不存在" }, { status: 404 });
    }

    // Telegram Bot Token 是无状态的，断开只是一个状态标记
    return NextResponse.json({
      state: 'idle',
      message: '已断开',
    });

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
