/**
 * 获取 Discord 服务器列表 API
 * POST /api/metadata/discord/guilds
 */

import { NextRequest, NextResponse } from "next/server";
import { connectionPool, buildDiscordCredentialKey } from "../../../../src/connectionPool";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
      return NextResponse.json({ error: "缺少 token 参数" }, { status: 400 });
    }

    const key = buildDiscordCredentialKey(token);
    const connection = connectionPool.getConnection(key);

    if (!connection || connection.type !== "discord") {
      return NextResponse.json({ error: "账号未连接" }, { status: 400 });
    }

    if (connection.status !== "connected") {
      return NextResponse.json({ error: "账号未连接" }, { status: 400 });
    }

    const client = connection.client;
    const guilds = client.guilds.cache.map((guild: any) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL(),
    }));

    return NextResponse.json({ guilds });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
