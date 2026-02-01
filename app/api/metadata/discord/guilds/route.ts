/**
 * 获取 Discord 服务器列表 API
 * POST /api/metadata/discord/guilds
 *
 * 注意：此 API 需要通过状态文件与 bot 进程通信
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

    // 读取缓存的服务器列表（由 bot 进程写入）
    const cacheFile = path.join(process.cwd(), ".data", "discord_guilds_cache.json");
    try {
      const data = await fs.readFile(cacheFile, "utf-8");
      const cache = JSON.parse(data);
      const accountData = cache[accountId];

      // 兼容新旧格式
      if (accountData && typeof accountData === 'object' && !Array.isArray(accountData)) {
        // 新格式：{ user: {...}, guilds: [...] }
        return NextResponse.json({
          user: accountData.user || null,
          guilds: accountData.guilds || [],
        });
      } else {
        // 旧格式：直接是数组
        return NextResponse.json({
          user: null,
          guilds: accountData || [],
        });
      }
    } catch {
      return NextResponse.json({ user: null, guilds: [], message: "请先启动实例以获取服务器列表" });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
