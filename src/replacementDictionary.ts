function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripFormatCharacters(value: string): string {
  return value.replace(/\p{Cf}/gu, "");
}

function buildReplacementPattern(from: string): RegExp | null {
  const cleaned = stripFormatCharacters(String(from ?? ""));
  if (!cleaned) return null;

  const source = Array.from(cleaned)
    .map((char) => {
      if (/\s/u.test(char)) {
        return "\\s+";
      }
      return escapeRegex(char);
    })
    .join("(?:\\p{Cf})*");

  return new RegExp(source, "giu");
}

export function applyReplacementDictionary(
  value: unknown,
  dictionary?: Record<string, string>,
): unknown {
  if (typeof value !== "string" || !dictionary || Object.keys(dictionary).length === 0) {
    return value;
  }

  let next = value;
  for (const [from, to] of Object.entries(dictionary)) {
    const pattern = buildReplacementPattern(from);
    if (!pattern) continue;
    next = next.replace(pattern, () => String(to ?? ""));
  }

  return next;
}
