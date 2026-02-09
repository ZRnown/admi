/**
 * Discord 账号数据同步 API
 * POST /api/metadata/discord/sync
 *
 * 主动登录 Discord 账号，获取服务器、频道和好友列表
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import https from "https";
import { ProxyAgent } from "proxy-agent";
import { getMultiConfig } from "@/src/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Discord API 基础 URL
const DISCORD_API = "https://discord.com/api/v10";

// 缓存文件路径
const DATA_DIR = path.join(process.cwd(), ".data");
const GUILDS_CACHE_FILE = path.join(DATA_DIR, "discord_guilds_cache.json");
const CHANNELS_CACHE_FILE = path.join(DATA_DIR, "discord_channels_cache.json");
const FRIENDS_CACHE_FILE = path.join(DATA_DIR, "discord_friends_cache.json");

// 确保数据目录存在
async function ensureDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {
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

function isNetworkErrorMessage(message: string) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("fetch failed") ||
    text.includes("socket hang up") ||
    text.includes("econnreset") ||
    text.includes("econnrefused") ||
    text.includes("etimedout") ||
    text.includes("enotfound") ||
    text.includes("certificate") ||
    text.includes("tls") ||
    text.includes("network_error") ||
    text.includes("network")
  );
}

async function discordFetchViaHttps(endpoint: string, token: string, dispatcher?: unknown) {
  const url = new URL(`${DISCORD_API}${endpoint}`);
  const options: https.RequestOptions = {
    hostname: url.hostname,
    port: url.port ? Number(url.port) : 443,
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    timeout: 20000,
    agent: dispatcher as any,
  };

  return await new Promise<any>((resolve, reject) => {
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        const status = Number(res.statusCode || 0);
        if (status >= 200 && status < 300) {
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch (e: any) {
            reject(new Error(`network_error:parse_json_failed:${String(e?.message || e)}`));
          }
          return;
        }
        reject(new Error(`discord_api_error:${status}:${body}`));
      });
    });

    req.on("error", (e: any) => {
      reject(new Error(`network_error:${String(e?.message || e)}`));
    });

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });

    req.end();
  });
}

// Discord API 请求
async function discordFetch(endpoint: string, token: string, dispatcher?: unknown) {
  const init: RequestInit & { dispatcher?: unknown } = {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    // 给外网请求设置超时，避免前端一直转圈
    signal: AbortSignal.timeout(20000),
  };

  if (dispatcher) {
    init.dispatcher = dispatcher;
  }

  try {
    const res = await fetch(`${DISCORD_API}${endpoint}`, init);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`discord_api_error:${res.status}:${text}`);
    }
    return res.json();
  } catch (e: any) {
    const detail = String(e?.message || "");
    if (!isNetworkErrorMessage(detail)) {
      throw e;
    }

    // 某些环境中 undici fetch 会偶发 fetch failed，这里回退 https.request
    return await discordFetchViaHttps(endpoint, token, dispatcher);
  }
}

// 获取当前用户信息
async function getCurrentUser(token: string, dispatcher?: unknown) {
  return discordFetch("/users/@me", token, dispatcher);
}

// 获取用户的服务器列表
async function getGuilds(token: string, dispatcher?: unknown) {
  return discordFetch("/users/@me/guilds", token, dispatcher);
}

// 获取服务器的频道列表
async function getGuildChannels(token: string, guildId: string, dispatcher?: unknown) {
  return discordFetch(`/guilds/${guildId}/channels`, token, dispatcher);
}

// 获取好友关系（仅用户账号可用）
async function getRelationships(token: string, dispatcher?: unknown) {
  return discordFetch("/users/@me/relationships", token, dispatcher);
}

// 获取私聊频道（用于补充可发送对象）
async function getPrivateChannels(token: string, dispatcher?: unknown) {
  return discordFetch("/users/@me/channels", token, dispatcher);
}

async function resolveProxyUrl(accountId?: string, inputProxyUrl?: string) {
  const bodyProxy = typeof inputProxyUrl === "string" && inputProxyUrl.trim() ? inputProxyUrl.trim() : "";
  if (bodyProxy) return bodyProxy;

  if (accountId) {
    try {
      const multi = await getMultiConfig();
      const libraryAccount = (multi.discordAccounts || []).find((item) => item.id === accountId);
      if (libraryAccount?.proxyUrl && libraryAccount.proxyUrl.trim()) {
        return libraryAccount.proxyUrl.trim();
      }

      const instanceAccount = (multi.accounts || []).find(
        (item) => item.discordAccountId === accountId || item.id === accountId,
      );
      if (instanceAccount?.proxyUrl && instanceAccount.proxyUrl.trim()) {
        return instanceAccount.proxyUrl.trim();
      }
    } catch {
      // 忽略配置读取失败，继续走环境变量
    }
  }

  return process.env.PROXY_URL || "";
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, token, type, proxyUrl } = body;

    if (!accountId) {
      return NextResponse.json({ error: "缺少 accountId 参数" }, { status: 400 });
    }

    if (!token) {
      return NextResponse.json({ error: "缺少 token 参数" }, { status: 400 });
    }

    await ensureDataDir();

    const resolvedProxyUrl = await resolveProxyUrl(accountId, proxyUrl);
    const configuredDispatcher = resolvedProxyUrl ? new ProxyAgent(resolvedProxyUrl as any) : undefined;

    let activeDispatcher: unknown = configuredDispatcher;
    let proxyBypassed = false;

    // 统一请求：如果代理网络失败，自动降级为直连重试一次
    const requestWithProxyFallback = async <T>(
      requestFn: (dispatcher?: unknown) => Promise<T>,
      label: string,
    ): Promise<T> => {
      try {
        return await requestFn(activeDispatcher);
      } catch (e: any) {
        const detail = String(e?.message || "");
        const canFallbackToDirect = Boolean(activeDispatcher) && isNetworkErrorMessage(detail);
        if (!canFallbackToDirect) {
          throw e;
        }

        console.warn(`[DiscordSync] ${label} 代理请求失败，自动降级直连重试: ${detail}`);
        proxyBypassed = true;
        activeDispatcher = undefined;
        return await requestFn(undefined);
      }
    };

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
          user = await requestWithProxyFallback((dispatcher) => getCurrentUser(candidate, dispatcher), "users/@me");
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
      const detail = String(e?.message || "");
      const looksLikeNetwork = isNetworkErrorMessage(detail);
      return NextResponse.json(
        {
          error: looksLikeNetwork
            ? "连接 Discord API 失败，请检查代理设置或网络"
            : "获取用户信息失败，请检查 Token 是否正确",
          detail,
          proxyConfigured: Boolean(resolvedProxyUrl),
          proxyBypassed,
        },
        { status: looksLikeNetwork ? 502 : 401 },
      );
    }

    // 获取服务器列表（失败时不阻断好友同步）
    let guilds: any[] = [];
    let guildsError = "";
    try {
      const data = await requestWithProxyFallback((dispatcher) => getGuilds(authToken, dispatcher), "users/@me/guilds");
      guilds = Array.isArray(data) ? data : [];
    } catch (e: any) {
      guildsError = String(e?.message || "");
      guilds = [];
      console.warn(`[DiscordSync] 获取服务器列表失败，继续同步好友: ${guildsError}`);
    }

    // 尝试获取好友列表（机器人 token 可能返回 401/403，忽略即可）
    let formattedFriends: Array<{
      id: string;
      username?: string;
      discriminator?: string;
      globalName?: string;
      avatar?: string;
      tag?: string;
      type?: string;
    }> = [];
    let friendsError = "";
    try {
      const relationships = await requestWithProxyFallback(
        (dispatcher) => getRelationships(authToken, dispatcher),
        "users/@me/relationships",
      );
      if (Array.isArray(relationships)) {
        formattedFriends = relationships
          .filter((item: any) => Number(item?.type) === 1 && item?.user)
          .map((item: any) => {
            const relationUser = item.user || {};
            const username =
              typeof relationUser.username === "string" ? relationUser.username : undefined;
            const discriminator =
              typeof relationUser.discriminator === "string"
                ? relationUser.discriminator
                : undefined;
            return {
              id: String(relationUser.id || ""),
              username,
              discriminator,
              globalName:
                typeof relationUser.global_name === "string"
                  ? relationUser.global_name
                  : undefined,
              avatar: typeof relationUser.avatar === "string" ? relationUser.avatar : undefined,
              tag:
                username && discriminator && discriminator !== "0"
                  ? `${username}#${discriminator}`
                  : username,
              type: "friend",
            };
          })
          .filter((item) => !!item.id);
      }
    } catch (e: any) {
      friendsError = String(e?.message || "");
      formattedFriends = [];
      console.warn(`[DiscordSync] 获取好友列表失败: ${friendsError}`);
    }

    // 额外获取私聊联系人：部分账号可能没有“好友关系”，但可以给私聊联系人发消息
    let formattedDmContacts: Array<{
      id: string;
      username?: string;
      discriminator?: string;
      globalName?: string;
      avatar?: string;
      tag?: string;
      type?: string;
    }> = [];
    let dmChannelsError = "";
    try {
      const dmChannels = await requestWithProxyFallback(
        (dispatcher) => getPrivateChannels(authToken, dispatcher),
        "users/@me/channels",
      );
      if (Array.isArray(dmChannels)) {
        const dedup = new Map<string, any>();
        dmChannels
          .filter((channel: any) => Number(channel?.type) === 1 && Array.isArray(channel?.recipients))
          .forEach((channel: any) => {
            for (const recipient of channel.recipients || []) {
              const id = String(recipient?.id || "");
              if (!id) continue;
              if (dedup.has(id)) continue;
              const username = typeof recipient?.username === "string" ? recipient.username : undefined;
              const discriminator =
                typeof recipient?.discriminator === "string" ? recipient.discriminator : undefined;
              dedup.set(id, {
                id,
                username,
                discriminator,
                globalName:
                  typeof recipient?.global_name === "string" ? recipient.global_name : undefined,
                avatar: typeof recipient?.avatar === "string" ? recipient.avatar : undefined,
                tag:
                  username && discriminator && discriminator !== "0"
                    ? `${username}#${discriminator}`
                    : username,
                type: "dm",
              });
            }
          });
        formattedDmContacts = Array.from(dedup.values());
      }
    } catch (e: any) {
      dmChannelsError = String(e?.message || "");
      formattedDmContacts = [];
      console.warn(`[DiscordSync] 获取私聊联系人失败: ${dmChannelsError}`);
    }

    // 朋友优先，其次补充私聊联系人
    const targetById = new Map<string, {
      id: string;
      username?: string;
      discriminator?: string;
      globalName?: string;
      avatar?: string;
      tag?: string;
      type?: string;
    }>();
    formattedDmContacts.forEach((item) => {
      targetById.set(item.id, item);
    });
    formattedFriends.forEach((item) => {
      targetById.set(item.id, item);
    });
    const formattedTargets = Array.from(targetById.values());

    // 格式化服务器数据
    const formattedGuilds = guilds.map((g: any) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
    }));

    // 获取每个服务器的频道列表
    const channelsData: Record<string, any[]> = {};
    for (const guild of guilds) {
      try {
        const channels = await requestWithProxyFallback(
          (dispatcher) => getGuildChannels(authToken, guild.id, dispatcher),
          `guilds/${guild.id}/channels`,
        );
        channelsData[guild.id] = Array.isArray(channels)
          ? channels.map((c: any) => ({
              id: c.id,
              name: c.name,
              type: c.type,
              parentId: c.parent_id,
              position: c.position,
            }))
          : [];
      } catch {
        // 某些服务器可能没有权限获取频道
        channelsData[guild.id] = [];
      }
    }

    // 读取现有缓存
    let guildsCache: Record<string, any> = {};
    let channelsCache: Record<string, any> = {};
    let friendsCache: Record<string, any> = {};

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

    try {
      const data = await fs.readFile(FRIENDS_CACHE_FILE, "utf-8");
      friendsCache = JSON.parse(data);
    } catch {
      // 文件不存在
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

    friendsCache[accountId] = {
      friends: formattedTargets,
      updatedAt: new Date().toISOString(),
    };

    // 写入缓存文件
    await fs.writeFile(GUILDS_CACHE_FILE, JSON.stringify(guildsCache, null, 2));
    await fs.writeFile(CHANNELS_CACHE_FILE, JSON.stringify(channelsCache, null, 2));
    await fs.writeFile(FRIENDS_CACHE_FILE, JSON.stringify(friendsCache, null, 2));

    return NextResponse.json({
      success: true,
      user: guildsCache[accountId].user,
      guildsCount: formattedGuilds.length,
      channelsCount: Object.values(channelsData).reduce((sum, arr) => sum + arr.length, 0),
      friendsCount: formattedTargets.length,
      proxyConfigured: Boolean(resolvedProxyUrl),
      proxyBypassed,
      guildsError: guildsError || undefined,
      friendsError: friendsError || undefined,
      dmChannelsError: dmChannelsError || undefined,
    });
  } catch (error: any) {
    console.error("Discord sync error:", error);
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 });
  }
}
