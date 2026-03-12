export function getDiscordMetadataAccountId(account?: { discordAccountId?: string; id?: string } | null): string {
  return String(account?.discordAccountId || account?.id || "").trim();
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

export function preserveDiscordChannelsOnFetchFailure<T>(existing: T[] | undefined, fetched: T[], hadFetchError: boolean): T[] {
  if (hadFetchError && Array.isArray(existing) && existing.length > 0) {
    return existing;
  }
  return fetched;
}
