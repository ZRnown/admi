import { stripLanguages } from "./languageFilter.js";

function applyReplacementDictionary(value: unknown, dictionary?: Record<string, string>): unknown {
  if (typeof value !== "string" || !dictionary || Object.keys(dictionary).length === 0) {
    return value;
  }
  let next = value;
  for (const [from, to] of Object.entries(dictionary)) {
    if (!from) continue;
    next = next.replaceAll(from, String(to ?? ""));
  }
  return next;
}

export function applyReplacementDictionaryToEmbeds(
  embeds: any[] | undefined,
  dictionary?: Record<string, string>,
): any[] | undefined {
  if (!embeds || embeds.length === 0 || !dictionary || Object.keys(dictionary).length === 0) {
    return embeds;
  }
  return embeds.map((embed) => {
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
    if (typeof next.title === "string") next.title = applyReplacementDictionary(next.title, dictionary);
    if (typeof next.description === "string") next.description = applyReplacementDictionary(next.description, dictionary);
    if (next.footer && typeof next.footer === "object") {
      next.footer = { ...next.footer };
      if (typeof next.footer.text === "string") {
        next.footer.text = applyReplacementDictionary(next.footer.text, dictionary);
      }
    }
    if (next.author && typeof next.author === "object") {
      next.author = { ...next.author };
      if (typeof next.author.name === "string") {
        next.author.name = applyReplacementDictionary(next.author.name, dictionary);
      }
    }
    if (Array.isArray(next.fields)) {
      next.fields = next.fields.map((field: any) => {
        if (!field || typeof field !== "object") return field;
        const copy = { ...field };
        if (typeof copy.name === "string") copy.name = applyReplacementDictionary(copy.name, dictionary);
        if (typeof copy.value === "string") copy.value = applyReplacementDictionary(copy.value, dictionary);
        return copy;
      });
    }
    return next;
  });
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
    if ("title" in next) {
      delete next.title;
    }
    if ("author" in next) {
      delete next.author;
    }
    return next;
  });
}
