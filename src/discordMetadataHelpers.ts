export function getDiscordMetadataAccountId(account?: { discordAccountId?: string; id?: string } | null): string {
  return String(account?.discordAccountId || account?.id || "").trim();
}

export const DISCORD_PRIVATE_SCOPE_ID = "@private";
export const DISCORD_PRIVATE_SCOPE_LABEL = "私聊";

const DISCORD_CHANNEL_URL_RE =
  /^https?:\/\/(?:canary\.)?discord(?:app)?\.com\/channels\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/i;

export function isDiscordPrivateScope(guildId?: string | null): boolean {
  return String(guildId || "").trim() === DISCORD_PRIVATE_SCOPE_ID;
}

export function normalizeDiscordSourceReference(
  sourceChannelId?: string | null,
  sourceGuildId?: string | null,
): { channelId: string; guildId?: string; messageId?: string } {
  const channelValue = String(sourceChannelId || "").trim();
  const guildValue = String(sourceGuildId || "").trim();
  if (!channelValue) {
    return { channelId: "", guildId: guildValue || undefined };
  }

  const match = channelValue.match(DISCORD_CHANNEL_URL_RE);
  if (!match) {
    return { channelId: channelValue, guildId: guildValue || undefined };
  }

  const [, parsedGuildId, parsedChannelId, parsedMessageId] = match;
  const guildId = guildValue || (parsedGuildId !== "@me" ? parsedGuildId : "");
  return {
    channelId: parsedChannelId,
    guildId: guildId || undefined,
    messageId: parsedMessageId || undefined,
  };
}

function buildDiscordMetadataAccountIds(
  accountId: string,
  config?: DiscordMetadataConfigLike | null,
): string[] {
  const normalizedAccountId = String(accountId || "").trim();
  const ids = new Set<string>();
  const add = (value?: string | null) => {
    const normalized = String(value || "").trim();
    if (!normalized) return;
    ids.add(normalized);
  };

  add(normalizedAccountId);

  for (const account of config?.accounts || []) {
    const instanceId = String(account?.id || "").trim();
    const libraryId = String(account?.discordAccountId || "").trim();
    if (normalizedAccountId === instanceId || normalizedAccountId === libraryId) {
      add(instanceId);
      add(libraryId);
    }
  }

  return Array.from(ids);
}

function normalizeDiscordNamedQuery(query?: string): string {
  return String(query || "").trim().toLowerCase();
}

export function filterDiscordNamedItems<T extends { id?: string | null; name?: string | null }>(
  items: readonly T[] | undefined,
  query?: string,
  selectedId?: string,
): T[] {
  const list = Array.isArray(items) ? [...items] : [];
  const normalizedQuery = normalizeDiscordNamedQuery(query);
  if (!normalizedQuery) return list;

  const filtered = list.filter((item) => {
    const id = String(item?.id || "").toLowerCase();
    const name = String(item?.name || "").toLowerCase();
    return id.includes(normalizedQuery) || name.includes(normalizedQuery);
  });

  if (!selectedId) return filtered;

  const selected = list.find((item) => String(item?.id || "") === String(selectedId));
  if (selected && !filtered.some((item) => String(item?.id || "") === String(selectedId))) {
    filtered.push(selected);
  }
  return filtered;
}

export function buildDiscordSearchableDropdownModel<T extends { id?: string | null; name?: string | null }>(
  items: readonly T[] | undefined,
  options: {
    selectedId?: string;
    selectedLabel?: string;
    query?: string;
    placeholderLabel: string;
    emptyResultsLabel: string;
  },
): {
  triggerLabel: string;
  emptyLabel: string;
  visibleItems: T[];
} {
  const list = Array.isArray(items) ? [...items] : [];
  const visibleItems = filterDiscordNamedItems(list, options.query, options.selectedId);
  const selectedItem = list.find((item) => String(item?.id || "") === String(options.selectedId || ""));
  const fallbackSelectedLabel = String(options.selectedLabel || "").trim();
  const triggerLabel = selectedItem?.name || fallbackSelectedLabel || options.placeholderLabel;
  const emptyLabel = visibleItems.length === 0 && normalizeDiscordNamedQuery(options.query)
    ? options.emptyResultsLabel
    : "";

  return {
    triggerLabel,
    emptyLabel,
    visibleItems,
  };
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
  if (!guildId) return "请先选择服务器或私聊";
  if (isDiscordPrivateScope(guildId)) {
    if (selectedId) return "加载私聊中...";
    return hasCacheEntry ? "暂无可用私聊" : "暂无私聊（请先同步）";
  }
  if (selectedId) return "加载频道中...";
  return hasCacheEntry ? "暂无可用频道" : "暂无频道（请先同步）";
}

type DiscordMetadataConfigLike = {
  accounts?: Array<{ id?: string | null; discordAccountId?: string | null }>;
};

type DiscordGuildLike = {
  id?: string | null;
  name?: string | null;
};

type DiscordGuildCacheEntry =
  | DiscordGuildLike[]
  | {
      guilds?: DiscordGuildLike[];
      privateChannels?: DiscordChannelLike[];
    }
  | undefined;

type DiscordChannelLike = {
  id?: string | null;
  name?: string | null;
  type?: number | null;
};

function readGuildListFromCacheEntry(entry: DiscordGuildCacheEntry): DiscordGuildLike[] {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object" && Array.isArray(entry.guilds)) {
    return entry.guilds;
  }
  return [];
}

function readPrivateChannelListFromCacheEntry(entry: DiscordGuildCacheEntry): DiscordChannelLike[] {
  if (entry && !Array.isArray(entry) && typeof entry === "object" && Array.isArray(entry.privateChannels)) {
    return entry.privateChannels;
  }
  return [];
}

export function buildDiscordChannelCacheKeys(
  accountId: string,
  guildId: string,
  config?: DiscordMetadataConfigLike | null,
): string[] {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return [];
  return buildDiscordMetadataAccountIds(accountId, config).map((id) => `${id}:${normalizedGuildId}`);
}

export function resolveDiscordChannelsFromCache<T>(
  cache: Record<string, T[] | undefined>,
  accountId: string,
  guildId: string,
  config?: DiscordMetadataConfigLike | null,
): T[] {
  const keys = buildDiscordChannelCacheKeys(accountId, guildId, config);
  for (const key of keys) {
    const channels = cache[key];
    if (Array.isArray(channels) && channels.length > 0) {
      return channels;
    }
  }
  for (const key of keys) {
    const channels = cache[key];
    if (Array.isArray(channels)) {
      return channels;
    }
  }
  return [];
}

export function resolveDiscordGuildsFromCache(
  cache: Record<string, DiscordGuildCacheEntry>,
  accountId: string,
  config?: DiscordMetadataConfigLike | null,
): DiscordGuildLike[] {
  const keys = buildDiscordMetadataAccountIds(accountId, config);
  for (const key of keys) {
    const guilds = readGuildListFromCacheEntry(cache[key]);
    if (guilds.length > 0) return guilds;
  }
  for (const key of keys) {
    const guilds = readGuildListFromCacheEntry(cache[key]);
    if (Array.isArray(guilds)) return guilds;
  }
  return [];
}

export function resolveDiscordPrivateChannelsFromCache<T extends DiscordChannelLike>(
  cache: Record<string, DiscordGuildCacheEntry>,
  accountId: string,
  config?: DiscordMetadataConfigLike | null,
): T[] {
  const keys = buildDiscordMetadataAccountIds(accountId, config);
  for (const key of keys) {
    const channels = readPrivateChannelListFromCacheEntry(cache[key]);
    if (channels.length > 0) return channels as T[];
  }
  for (const key of keys) {
    const channels = readPrivateChannelListFromCacheEntry(cache[key]);
    if (Array.isArray(channels)) return channels as T[];
  }
  return [];
}

export function resolveDiscordGuildNameFromCache(
  cache: Record<string, DiscordGuildCacheEntry>,
  accountId: string,
  guildId: string,
  config?: DiscordMetadataConfigLike | null,
): string {
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) return "";
  const guilds = resolveDiscordGuildsFromCache(cache, accountId, config);
  const match = guilds.find((guild) => String(guild?.id || "") === normalizedGuildId);
  return String(match?.name || "").trim();
}

export function resolveDiscordChannelNameFromCache<T extends { id?: string | null; name?: string | null }>(
  cache: Record<string, T[] | undefined>,
  accountId: string,
  guildId: string,
  channelId: string,
  config?: DiscordMetadataConfigLike | null,
): string {
  const normalizedChannelId = String(channelId || "").trim();
  if (!normalizedChannelId) return "";
  const channels = resolveDiscordChannelsFromCache(cache, accountId, guildId, config);
  const match = channels.find((channel) => String(channel?.id || "") === normalizedChannelId);
  return String(match?.name || "").trim();
}

export function resolveDiscordChannelMetadataFromCache<T extends { id?: string | null; name?: string | null }>(
  channelsCache: Record<string, T[] | undefined>,
  guildsCache: Record<string, DiscordGuildCacheEntry>,
  accountId: string,
  channelId: string,
  config?: DiscordMetadataConfigLike | null,
  guildId?: string,
): {
  guildId?: string;
  guildName?: string;
  channelName?: string;
} {
  const normalizedChannelId = String(channelId || "").trim();
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedChannelId) {
    return {
      guildId: normalizedGuildId || undefined,
    };
  }

  let resolvedGuildId = normalizedGuildId || undefined;
  let guildName = normalizedGuildId
    ? resolveDiscordGuildNameFromCache(guildsCache, accountId, normalizedGuildId, config)
    : "";
  let channelName = normalizedGuildId
    ? resolveDiscordChannelNameFromCache(channelsCache, accountId, normalizedGuildId, normalizedChannelId, config)
    : "";

  if (channelName && (resolvedGuildId || guildName)) {
    return {
      guildId: resolvedGuildId,
      guildName: guildName || undefined,
      channelName,
    };
  }

  const accountPrefixes = buildDiscordMetadataAccountIds(accountId, config).map((id) => `${id}:`);
  for (const [cacheKey, channels] of Object.entries(channelsCache || {})) {
    if (!accountPrefixes.some((prefix) => cacheKey.startsWith(prefix))) continue;
    if (!Array.isArray(channels)) continue;
    const match = channels.find((channel) => String(channel?.id || "") === normalizedChannelId);
    if (!match) continue;

    const separatorIndex = cacheKey.indexOf(":");
    const matchedGuildId = separatorIndex >= 0 ? cacheKey.slice(separatorIndex + 1) : "";
    if (!resolvedGuildId && matchedGuildId) {
      resolvedGuildId = matchedGuildId;
    }
    if (!channelName) {
      channelName = String(match?.name || "").trim();
    }
    if (!guildName && matchedGuildId) {
      guildName = resolveDiscordGuildNameFromCache(guildsCache, accountId, matchedGuildId, config);
    }

    if (channelName && (resolvedGuildId || guildName)) {
      break;
    }
  }

  return {
    guildId: resolvedGuildId,
    guildName: guildName || undefined,
    channelName: channelName || undefined,
  };
}

export function preserveDiscordChannelsOnFetchFailure<T>(existing: T[] | undefined, fetched: T[], hadFetchError: boolean): T[] {
  if (hadFetchError && Array.isArray(existing) && existing.length > 0) {
    return existing;
  }
  return fetched;
}
