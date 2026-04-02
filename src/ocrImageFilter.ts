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

export function stripUploadedEmbedImages<
  T extends { url?: string; sourceUrl?: string; isImage?: boolean }
>(
  embeds: any[] | undefined,
  uploads: T[] | undefined,
): any[] | undefined {
  if (!embeds || embeds.length === 0 || !uploads || uploads.length === 0) return embeds;

  const uploadedImageUrls = new Set<string>();
  for (const upload of uploads) {
    if (!upload?.isImage) continue;
    markBlockedImageUrl(uploadedImageUrls, upload.url);
    markBlockedImageUrl(uploadedImageUrls, upload.sourceUrl);
  }

  if (uploadedImageUrls.size === 0) return embeds;
  return stripBlockedEmbedImages(embeds, uploadedImageUrls);
}

function hasVisualEmbedContent(embed: any): boolean {
  return (
    Boolean(embed?.image?.url) ||
    Boolean(embed?.thumbnail?.url) ||
    (typeof embed?.url === "string" && embed.url.trim().length > 0 && embed.type === "image")
  );
}

function hasTextualEmbedContent(embed: any): boolean {
  return (
    Boolean(embed?.title) ||
    Boolean(embed?.description) ||
    (Array.isArray(embed?.fields) && embed.fields.length > 0) ||
    Boolean(embed?.author?.name) ||
    Boolean(embed?.footer?.text)
  );
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

      const hadVisual = hasVisualEmbedContent(raw);
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

      const hasVisual = hasVisualEmbedContent(next);
      const hasTextual = hasTextualEmbedContent(next);

      if (hadVisual && !hasVisual && !hasTextual) {
        return null;
      }
      return next;
    })
    .filter((item) => item !== null);

  return result.length > 0 ? result : undefined;
}

export function stripAllEmbedImages(
  embeds: any[] | undefined,
): any[] | undefined {
  if (!embeds || embeds.length === 0) return embeds;

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

      const hadVisual = hasVisualEmbedContent(raw);
      const next: any = { ...raw };
      delete next.image;
      delete next.thumbnail;
      if (next.type === "image") {
        delete next.url;
      }

      const hasTextual = hasTextualEmbedContent(next);

      if (hadVisual && !hasTextual) {
        return null;
      }
      return next;
    })
    .filter((item) => item !== null);

  return result.length > 0 ? result : undefined;
}
