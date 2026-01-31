/**
 * 获取 Discord 频道列表 API
 * POST /api/metadata/discord/channels
 *
 * 注意：此 API 需要通过状态文件与 bot 进程通信
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, guildId } = body;

    if (!accountId || !guildId) {
      return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    }

    // 读取缓存的频道列表（由 bot 进程写入）
    const cacheFile = path.join(process.cwd(), ".data", "discord_channels_cache.json");
    try {
      const data = await fs.readFile(cacheFile, "utf-8");
      const cache = JSON.parse(data);
      const key = `${accountId}:${guildId}`;
      const channels = cache[key] || [];
      return NextResponse.json({ channels });
    } catch {
      return NextResponse.json({ channels: [], message: "请先启动实例以获取频道列表" });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
