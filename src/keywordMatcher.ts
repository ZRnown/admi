export type KeywordGroup = string[];
export type MatchOptions = {
  caseInsensitive?: boolean;
};

export function parseKeywordGroups(input?: unknown): KeywordGroup[] {
  if (!Array.isArray(input)) return [];
  const groups: KeywordGroup[] = [];

  for (const entry of input) {
    if (!entry) continue;
    if (Array.isArray(entry)) {
      const parts = entry.map((item) => String(item).trim()).filter(Boolean);
      if (parts.length > 0) {
        groups.push(parts);
      }
      continue;
    }
    const raw = String(entry).trim();
    if (!raw) continue;
    const parts = raw
      .split(/[，,&＆]/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      groups.push(parts);
    }
  }

  return groups;
}

function normalizeMatchText(value: string, caseInsensitive: boolean): string {
  let output = String(value ?? "");
  try {
    output = output.normalize("NFKC");
  } catch {}
  output = output.replace(/\p{Cf}/gu, "");
  return caseInsensitive ? output.toLowerCase() : output;
}

export function matchParsedKeywordGroups(
  text: string,
  groups: KeywordGroup[],
  options: MatchOptions = {},
): { matchedGroups: KeywordGroup[]; matchedKeywords: string[] } {
  if (groups.length === 0) {
    return { matchedGroups: [], matchedKeywords: [] };
  }

  const caseInsensitive = options.caseInsensitive !== false;
  const haystack = normalizeMatchText(text, caseInsensitive);
  const matchedGroups = groups.filter((group) =>
    group.every((keyword) => {
      const needle = normalizeMatchText(keyword, caseInsensitive);
      return haystack.includes(needle);
    }),
  );
  const matchedKeywords = Array.from(new Set(matchedGroups.flat()));

  return { matchedGroups, matchedKeywords };
}

export function matchKeywordGroups(
  text: string,
  rawGroups?: unknown,
  options?: MatchOptions,
): {
  matchedGroups: KeywordGroup[];
  matchedKeywords: string[];
} {
  const groups = parseKeywordGroups(rawGroups);
  return matchParsedKeywordGroups(text, groups, options);
}

export function hasKeywordGroupMatch(
  text: string,
  rawGroups?: unknown,
  options?: MatchOptions,
): boolean {
  return matchKeywordGroups(text, rawGroups, options).matchedGroups.length > 0;
}

export function formatKeywordGroups(groups: KeywordGroup[]): string {
  return groups.map((group) => group.join("&")).join(" | ");
}
