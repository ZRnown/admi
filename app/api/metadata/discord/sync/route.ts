/**
 * Discord 账号数据同步 API
 * POST /api/metadata/discord/sync
 *
 * 主动登录 Discord 账号，获取服务器和频道列表
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { preserveDiscordChannelsOnFetchFailure } from "@/src/discordMetadataHelpers";

// Discord API 基础 URL
const DISCORD_API = "https://discord.com/api/v10";

// 缓存文件路径
const DATA_DIR = path.join(process.cwd(), ".data");
const GUILDS_CACHE_FILE = path.join(DATA_DIR, "discord_guilds_cache.json");
const CHANNELS_CACHE_FILE = path.join(DATA_DIR, "discord_channels_cache.json");

// 确保数据目录存在
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch (e) {
    // 目录已存在
  }
}

function stripBotPrefix(token: string) {
  const trimmed = token.trim();
  if (trimmed.toLowerCase().startsWith("bot ")) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

function buildAuthCandidates(token: string, type?: string) {
  const trimmed = token.trim();
  const stripped = stripBotPrefix(trimmed);
  const candidates: string[] = [];

  if (type === "bot") {
    candidates.push(trimmed.toLowerCase().startsWith("bot ") ? trimmed : `Bot ${trimmed}`);
    if (stripped) candidates.push(stripped);
  } else {
    if (stripped) candidates.push(stripped);
    candidates.push(trimmed.toLowerCase().startsWith("bot ") ? trimmed : `Bot ${trimmed}`);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

// Discord API 请求
async function discordFetch(endpoint: string, token: string) {
  const res = await fetch(`${DISCORD_API}${endpoint}`, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API error: ${res.status} ${text}`);
  }

  return res.json();
}

// 获取当前用户信息
async function getCurrentUser(token: string) {
  return discordFetch("/users/@me", token);
}

// 获取用户的服务器列表
async function getGuilds(token: string) {
  return discordFetch("/users/@me/guilds", token);
}

// 获取服务器的频道列表
async function getGuildChannels(token: string, guildId: string) {
  return discordFetch(`/guilds/${guildId}/channels`, token);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, token, type } = body;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId 参数" }, { status: 400 });
    }

    if (!token) {
      return NextResponse.json({ error: "缺少 token 参数" }, { status: 400 });
    }

    await ensureDataDir();

    const authCandidates = buildAuthCandidates(String(token), type);
    if (authCandidates.length === 0) {
      return NextResponse.json({ error: "缺少有效 token 参数" }, { status: 400 });
    }

    // 获取用户信息
    let user = null;
    let authToken = "";
    let lastError: any = null;
    try {
      for (const candidate of authCandidates) {
        try {
          user = await getCurrentUser(candidate);
          authToken = candidate;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      if (!user || !authToken) {
        throw lastError || new Error("invalid token");
      }
    } catch (e: any) {
      return NextResponse.json({
        error: "获取用户信息失败，请检查 Token 是否正确",
        detail: e.message
      }, { status: 401 });
    }

    // 获取服务器列表
    let guilds = [];
    try {
      guilds = await getGuilds(authToken);
    } catch (e: any) {
      return NextResponse.json({
        error: "获取服务器列表失败",
        detail: e.message
      }, { status: 500 });
    }

    // 格式化服务器数据
    const formattedGuilds = guilds.map((g: any) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
    }));

    // 读取现有缓存
    let guildsCache: Record<string, any> = {};
    let channelsCache: Record<string, any> = {};

    try {
      const data = await fs.readFile(GUILDS_CACHE_FILE, "utf-8");
      guildsCache = JSON.parse(data);
    } catch {
      // 文件不存在
    }

    try {
      const data = await fs.readFile(CHANNELS_CACHE_FILE, "utf-8");
      channelsCache = JSON.parse(data);
    } catch {
      // 文件不存在
    }

    // 获取每个服务器的频道列表
    const channelsData: Record<string, any[]> = {};
    for (const guild of guilds) {
      const cacheKey = `${accountId}:${guild.id}`;
      const existingChannels = Array.isArray(channelsCache[cacheKey]) ? channelsCache[cacheKey] : undefined;
      try {
        const channels = await getGuildChannels(authToken, guild.id);
        channelsData[guild.id] = channels.map((c: any) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          parentId: c.parent_id,
          position: c.position,
        }));
      } catch (e) {
        channelsData[guild.id] = preserveDiscordChannelsOnFetchFailure(existingChannels, [], true);
      }
    }

    // 更新缓存
    guildsCache[accountId] = {
      user: {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        globalName: user.global_name,
        avatar: user.avatar,
        tag: user.discriminator === "0" ? user.username : `${user.username}#${user.discriminator}`,
      },
      guilds: formattedGuilds,
      updatedAt: new Date().toISOString(),
    };

    // 更新频道缓存
    for (const [guildId, channels] of Object.entries(channelsData)) {
      const cacheKey = `${accountId}:${guildId}`;
      channelsCache[cacheKey] = channels;
    }

    // 写入缓存文件
    await fs.writeFile(GUILDS_CACHE_FILE, JSON.stringify(guildsCache, null, 2));
    await fs.writeFile(CHANNELS_CACHE_FILE, JSON.stringify(channelsCache, null, 2));

    return NextResponse.json({
      success: true,
      user: guildsCache[accountId].user,
      guildsCount: formattedGuilds.length,
      channelsCount: Object.values(channelsData).reduce((sum, arr) => sum + arr.length, 0),
    });
  } catch (error: any) {
    console.error("Discord sync error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
