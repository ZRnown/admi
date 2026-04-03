export function getDiscordMetadataAccountId(account?: { discordAccountId?: string; id?: string } | null): string {
  return String(account?.discordAccountId || account?.id || "").trim();
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
  if (!guildId) return "请先选择服务器";
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
    }
  | undefined;

function readGuildListFromCacheEntry(entry: DiscordGuildCacheEntry): DiscordGuildLike[] {
  if (Array.isArray(entry)) return entry;
  if (entry && typeof entry === "object" && Array.isArray(entry.guilds)) {
    return entry.guilds;
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

export function preserveDiscordChannelsOnFetchFailure<T>(existing: T[] | undefined, fetched: T[], hadFetchError: boolean): T[] {
  if (hadFetchError && Array.isArray(existing) && existing.length > 0) {
    return existing;
  }
  return fetched;
}
