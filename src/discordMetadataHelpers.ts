export function getDiscordMetadataAccountId(account?: { discordAccountId?: string; id?: string } | null): string {
  return String(account?.discordAccountId || account?.id || "").trim();
}

export function shouldReuseDiscordChannelsCache(
  cache: Record<string, unknown>,
  cacheKey: string,
  force = false,
): boolean {
  if (!cacheKey || force) return false;
  return Object.prototype.hasOwnProperty.call(cache, cacheKey);
}

export function getDiscordChannelEmptyMessage(hasCacheEntry: boolean, guildId: string, selectedId?: string): string {
  if (!guildId) return "请先选择服务器";
  if (selectedId) return "加载频道中...";
  return hasCacheEntry ? "暂无可用频道" : "暂无频道（请先同步）";
}

export function preserveDiscordChannelsOnFetchFailure<T>(existing: T[] | undefined, fetched: T[], hadFetchError: boolean): T[] {
  if (hadFetchError && Array.isArray(existing) && existing.length > 0) {
    return existing;
  }
  return fetched;
}
