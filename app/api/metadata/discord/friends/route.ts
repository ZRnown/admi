/**
 * 获取 Discord 好友列表 API
 * POST /api/metadata/discord/friends
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

    const cacheFile = path.join(process.cwd(), ".data", "discord_friends_cache.json");

    try {
      const raw = await fs.readFile(cacheFile, "utf-8");
      const cache = JSON.parse(raw);
      const accountData = cache?.[accountId];
      const friends = Array.isArray(accountData?.friends)
        ? accountData.friends
        : Array.isArray(accountData)
          ? accountData
          : [];
      const updatedAt =
        typeof accountData?.updatedAt === "string" && accountData.updatedAt.trim()
          ? accountData.updatedAt
          : undefined;
      return NextResponse.json({ friends, updatedAt });
    } catch {
      return NextResponse.json({ friends: [], message: "请先同步 Discord 账号以获取好友列表" });
    }
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
