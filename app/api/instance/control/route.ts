/**
 * 实例控制 API
 * POST /api/instance/start - 启动实例
 * POST /api/instance/stop - 停止实例
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, instanceId } = body;

    if (!instanceId) {
      return NextResponse.json({ error: "缺少 instanceId 参数" }, { status: 400 });
    }

    if (action === "start") {
      // 启动实例逻辑由后端 bot 进程处理
      // 前端只需要设置 loginRequested = true
      return NextResponse.json({ success: true, message: "启动请求已发送" });
    } else if (action === "stop") {
      // 停止实例逻辑由后端 bot 进程处理
      // 前端只需要设置 loginRequested = false
      return NextResponse.json({ success: true, message: "停止请求已发送" });
    } else {
      return NextResponse.json({ error: "无效的 action" }, { status: 400 });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
