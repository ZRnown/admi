/**
 * Discord 相关功能模块
 */

// 缓存的服务器和频道数据
let cachedGuilds = {};
let cachedChannels = {};

// 获取 Discord 服务器列表
async function fetchDiscordGuilds(accountId) {
  if (!accountId) return [];
  try {
    const res = await fetch('/api/metadata/discord/guilds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId })
    });
    const data = await res.json();
    const guilds = data.guilds || [];
    cachedGuilds[accountId] = guilds;
    return guilds;
  } catch (e) {
    console.error('获取服务器列表失败', e);
    return [];
  }
}

// 获取 Discord 频道列表
async function fetchDiscordChannels(accountId, guildId) {
  if (!accountId || !guildId) return [];
  try {
    const res = await fetch('/api/metadata/discord/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId, guildId })
    });
    const data = await res.json();
    const channels = data.channels || [];
    const key = `${accountId}:${guildId}`;
    cachedChannels[key] = channels;
    return channels;
  } catch (e) {
    console.error('获取频道列表失败', e);
    return [];
  }
}
