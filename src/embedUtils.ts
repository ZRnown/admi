import { stripLanguages } from "./languageFilter";

const NATIVE_PREVIEW_LINK_RE =
  /^<?https?:\/\/(?:(?:x|twitter)\.com|tenor\.com|giphy\.com)\/\S+>?$/i;

function normalizeImageUrl(url?: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] || url;
  }
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

function readEmbedRaw(embed: any): any {
  if (!embed || typeof embed !== "object") return embed;
  if (typeof embed.toJSON === "function") {
    try {
      return embed.toJSON();
    } catch {}
  } else if ("data" in embed && embed.data) {
    return embed.data;
  }
  return embed;
}

export function isNativePreviewLink(rawContent?: string): boolean {
  return NATIVE_PREVIEW_LINK_RE.test(String(rawContent || "").trim());
}

export function applyNativePreviewLinkMediaPolicy<T>(
  input: {
    rawContent?: string;
    uploads?: T[];
    extraEmbeds?: any[] | undefined;
  },
): {
  uploads: T[];
  extraEmbeds: any[] | undefined;
} {
  if (!isNativePreviewLink(input.rawContent)) {
    return {
      uploads: input.uploads || [],
      extraEmbeds: input.extraEmbeds,
    };
  }

  return {
    uploads: [],
    extraEmbeds: undefined,
  };
}

export function stripEmbedText(
  embeds: any[] | undefined,
  options: { stripEnglish?: boolean; stripChinese?: boolean },
): any[] | undefined {
  if (!embeds || embeds.length === 0) return embeds;
  if (!options.stripEnglish && !options.stripChinese) return embeds;
  const sanitizeText = (value: unknown) =>
    typeof value === "string" ? stripLanguages(value, options) : value;
  return embeds.map((embed) => {
    if (!embed || typeof embed !== "object") return embed;
    const raw: any = readEmbedRaw(embed);
    if (!raw || typeof raw !== "object") return raw;
    const next: any = { ...raw };
    if (typeof next.title === "string") next.title = sanitizeText(next.title);
    if (typeof next.description === "string") next.description = sanitizeText(next.description);
    if (next.footer && typeof next.footer === "object") {
      next.footer = { ...next.footer };
      if (typeof next.footer.text === "string") next.footer.text = sanitizeText(next.footer.text);
    }
    if (next.author && typeof next.author === "object") {
      next.author = { ...next.author };
      if (typeof next.author.name === "string") next.author.name = sanitizeText(next.author.name);
    }
    if (Array.isArray(next.fields)) {
      next.fields = next.fields.map((field: any) => {
        if (!field || typeof field !== "object") return field;
        const copy = { ...field };
        if (typeof copy.name === "string") copy.name = sanitizeText(copy.name);
        if (typeof copy.value === "string") copy.value = sanitizeText(copy.value);
        return copy;
      });
    }
    return next;
  });
}

export function stripEmbedTitles(embeds: any[] | undefined): any[] | undefined {
  if (!embeds || embeds.length === 0) return embeds;
  return embeds.map((embed) => {
    if (!embed || typeof embed !== "object") return embed;
    const raw: any = readEmbedRaw(embed);
    if (!raw || typeof raw !== "object") return raw;
    const next: any = { ...raw };
    if ("title" in next) {
      delete next.title;
    }
    if ("author" in next) {
      delete next.author;
    }
    return next;
  });
}

export function stripUploadedEmbedImages<
  T extends { url?: string; sourceUrl?: string; isImage?: boolean }
>(
  embeds: any[] | undefined,
  uploads: T[] | undefined,
): any[] | undefined {
  if (!embeds || embeds.length === 0 || !uploads || uploads.length === 0) return embeds;

  const uploadedUrls = new Set<string>();
  const markUrl = (url?: string) => {
    if (!url) return;
    uploadedUrls.add(url);
    const normalized = normalizeImageUrl(url);
    if (normalized) uploadedUrls.add(normalized);
  };

  for (const upload of uploads) {
    if (!upload?.isImage) continue;
    markUrl(upload.url);
    markUrl(upload.sourceUrl);
  }

  if (uploadedUrls.size === 0) return embeds;

  const filtered = embeds
    .map((embed) => {
      const raw = readEmbedRaw(embed);
      if (!raw || typeof raw !== "object") return raw;

      const hadVisual = hasVisualEmbedContent(raw);
      const next: any = { ...raw };
      const imageUrl = typeof next.image?.url === "string" ? next.image.url : undefined;
      const thumbnailUrl = typeof next.thumbnail?.url === "string" ? next.thumbnail.url : undefined;
      const rawUrl = typeof next.url === "string" ? next.url : undefined;

      const isUploaded = (url?: string) => {
        if (!url) return false;
        const normalized = normalizeImageUrl(url);
        return uploadedUrls.has(url) || (normalized ? uploadedUrls.has(normalized) : false);
      };

      if (isUploaded(imageUrl)) {
        delete next.image;
      }
      if (isUploaded(thumbnailUrl)) {
        delete next.thumbnail;
      }
      if ((next.type === "image" || imageUrl || thumbnailUrl) && isUploaded(rawUrl)) {
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

  return filtered.length > 0 ? filtered : undefined;
}
