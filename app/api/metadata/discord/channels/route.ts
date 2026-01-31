/**
 * 获取 Discord 频道列表 API
 * POST /api/metadata/discord/channels
 */

import { NextRequest, NextResponse } from "next/server";
import { connectionPool, buildDiscordCredentialKey } from "../../../../src/connectionPool";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, guildId } = body;

    if (!token || !guildId) {
      return NextResponse.json({ error: "缺少参数" }, { status: 400 });
    }

    const key = buildDiscordCredentialKey(token);
    const connection = connectionPool.getConnection(key);

    if (!connection || connection.type !== "discord" || connection.status !== "connected") {
      return NextResponse.json({ error: "账号未连接" }, { status: 400 });
    }

    const client = connection.client;
    const guild = client.guilds.cache.get(guildId);

    if (!guild) {
      return NextResponse.json({ error: "服务器不存在" }, { status: 404 });
    }

    const channels = guild.channels.cache
      .filter((ch: any) => ch.type === 0 || ch.type === 5) // 文字频道和公告频道
      .map((ch: any) => ({
        id: ch.id,
        name: ch.name,
        type: ch.type,
        parentId: ch.parentId,
        parentName: ch.parent?.name,
      }));

    return NextResponse.json({ channels });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
