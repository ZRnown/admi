function normalizeImageUrl(url?: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] || url;
  }
}

export function markBlockedImageUrl(blockedUrls: Set<string>, url?: string): void {
  if (!url) return;
  blockedUrls.add(url);
  const normalized = normalizeImageUrl(url);
  if (normalized) {
    blockedUrls.add(normalized);
  }
}

export function isBlockedImageUrl(blockedUrls: Set<string>, url?: string): boolean {
  if (!url) return false;
  const normalized = normalizeImageUrl(url);
  return blockedUrls.has(url) || (normalized ? blockedUrls.has(normalized) : false);
}

export function filterBlockedUploads<T extends { url: string }>(
  uploads: T[],
  blockedUrls: Set<string>,
): T[] {
  if (blockedUrls.size === 0) return uploads;
  return uploads.filter((item) => !isBlockedImageUrl(blockedUrls, item.url));
}

export function stripBlockedEmbedImages(
  embeds: any[] | undefined,
  blockedUrls: Set<string>,
): any[] | undefined {
  if (!embeds || embeds.length === 0 || blockedUrls.size === 0) return embeds;

  const result = embeds
    .map((embed) => {
      if (!embed || typeof embed !== "object") return embed;

      let raw: any = embed;
      if (typeof (embed as any).toJSON === "function") {
        try {
          raw = (embed as any).toJSON();
        } catch {}
      } else if ("data" in embed && (embed as any).data) {
        raw = (embed as any).data;
      }
      if (!raw || typeof raw !== "object") return raw;

      const next: any = { ...raw };
      const imageUrl = typeof next.image?.url === "string" ? next.image.url : undefined;
      const thumbnailUrl = typeof next.thumbnail?.url === "string" ? next.thumbnail.url : undefined;
      const rawUrl = typeof next.url === "string" ? next.url : undefined;
      const blockedImage = isBlockedImageUrl(blockedUrls, imageUrl);
      const blockedThumbnail = isBlockedImageUrl(blockedUrls, thumbnailUrl);
      const blockedRawUrl = (next.type === "image" || imageUrl || thumbnailUrl) && isBlockedImageUrl(blockedUrls, rawUrl);

      if (blockedImage) {
        delete next.image;
      }
      if (blockedThumbnail) {
        delete next.thumbnail;
      }
      if (blockedRawUrl) {
        delete next.url;
      }

      const hasVisual =
        Boolean(next.image?.url) ||
        Boolean(next.thumbnail?.url) ||
        (typeof next.url === "string" && next.url.trim().length > 0 && next.type === "image");
      const hasTextual =
        Boolean(next.title) ||
        Boolean(next.description) ||
        (Array.isArray(next.fields) && next.fields.length > 0) ||
        Boolean(next.author?.name) ||
        Boolean(next.footer?.text);

      if (!hasVisual && !hasTextual && next.type === "image") {
        return null;
      }
      return next;
    })
    .filter((item) => item !== null);

  return result.length > 0 ? result : undefined;
}
