export type LanguageRatio = {
  englishCount: number;
  chineseCount: number;
  total: number;
  englishRatio: number;
  chineseRatio: number;
};

export function getLanguageRatio(text: string): LanguageRatio {
  let englishCount = 0;
  let chineseCount = 0;
  const value = String(text || "");

  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      englishCount += 1;
      continue;
    }
    if (code >= 0x4e00 && code <= 0x9fff) {
      chineseCount += 1;
    }
  }

  const total = englishCount + chineseCount;
  const englishRatio = total > 0 ? (englishCount / total) * 100 : 0;
  const chineseRatio = total > 0 ? (chineseCount / total) * 100 : 0;

  return { englishCount, chineseCount, total, englishRatio, chineseRatio };
}

export function clampPercent(value: unknown, fallback = 100): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
}

const RE_ENGLISH = /[A-Za-z]/g;
const RE_CHINESE = /[\u4e00-\u9fff]/g;

export function stripLanguages(
  text: string,
  options: { stripEnglish?: boolean; stripChinese?: boolean },
): string {
  if (!text) return "";
  let next = String(text);
  if (options.stripChinese) {
    next = next.replace(RE_CHINESE, "");
  }
  if (options.stripEnglish) {
    next = next.replace(RE_ENGLISH, "");
  }
  return next;
}
