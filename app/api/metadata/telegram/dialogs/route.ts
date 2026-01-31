/**
 * 获取 Telegram 对话列表 API
 * POST /api/metadata/telegram/dialogs
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId } = body;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId 参数" }, { status: 400 });
    }

    // TODO: 通过 IPC 请求 Telegram Bridge 获取对话列表
    // 目前返回空列表，需要在 Telegram Bridge 中实现 get_dialogs 功能

    return NextResponse.json({
      dialogs: [],
      message: "需要先启动实例并连接 Telegram 账号"
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
