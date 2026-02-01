/**
 * 获取 Telegram 对话列表 API
 * POST /api/metadata/telegram/dialogs
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId } = body;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId 参数" }, { status: 400 });
    }

    // 读取缓存的对话列表（由 Telegram Bridge 写入）
    const cacheFile = path.join(process.cwd(), ".data", "telegram_dialogs_cache.json");
    const statusFile = path.join(process.cwd(), ".data", "status.json");

    let dialogs: any[] = [];
    let user: any = null;

    // 读取对话列表
    try {
      const data = await fs.readFile(cacheFile, "utf-8");
      const cache = JSON.parse(data);
      dialogs = cache[accountId] || [];
    } catch {
      // 文件不存在
    }

    // 读取用户信息（从状态文件）
    try {
      const statusData = await fs.readFile(statusFile, "utf-8");
      const status = JSON.parse(statusData);
      const accountStatus = status[accountId];
      if (accountStatus && accountStatus.userInfo) {
        user = accountStatus.userInfo;
      }
    } catch {
      // 文件不存在
    }

    if (dialogs.length === 0 && !user) {
      return NextResponse.json({
        user: null,
        dialogs: [],
        message: "请先启动实例并连接 Telegram 账号以获取对话列表"
      });
    }

    return NextResponse.json({ user, dialogs });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
