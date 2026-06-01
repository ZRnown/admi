/**
 * 获取 Discord 频道列表 API
 * POST /api/metadata/discord/channels
 *
 * 注意：此 API 需要通过状态文件与 bot 进程通信
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { resolveDiscordChannelsFromCache } from "@/src/discordMetadataHelpers";
import { getConfigPath } from "@/src/config";
import { resolveDataPath } from "@/src/paths";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, guildId } = body;

    if (!accountId || !guildId) {
      return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    }

    // 读取缓存的频道列表（由 bot 进程写入）
    const cacheFile = resolveDataPath("discord_channels_cache.json");
    const configFile = getConfigPath();
    try {
      const data = await fs.readFile(cacheFile, "utf-8");
      const cache = JSON.parse(data);
      let config: any = null;
      try {
        const raw = await fs.readFile(configFile, "utf-8");
        config = JSON.parse(raw);
      } catch {
        config = null;
      }
      const channels = resolveDiscordChannelsFromCache(cache, String(accountId), String(guildId), config);
      return NextResponse.json({ channels });
    } catch {
      return NextResponse.json({ channels: [], message: "请先启动实例以获取频道列表" });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
