export function normalizeOptionalString(value?: string | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveWebhookIdentity(
  sourceUsername?: string,
  sourceAvatarUrl?: string,
  targetWebhookName?: string,
  targetWebhookAvatarUrl?: string,
): { username?: string; avatarUrl?: string } {
  return {
    username: normalizeOptionalString(targetWebhookName) || normalizeOptionalString(sourceUsername),
    avatarUrl: normalizeOptionalString(targetWebhookAvatarUrl) || normalizeOptionalString(sourceAvatarUrl),
  };
}

export function buildWebhookAssetUrl(baseUrl: string | undefined, requestUrl: string, filename: string): string {
  const safeBase = normalizeOptionalString(baseUrl);
  const origin = safeBase || requestUrl;
  return new URL(`/api/webhook-avatar/${encodeURIComponent(filename)}`, origin).toString();
}
