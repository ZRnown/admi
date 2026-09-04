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

function buildLineRemovalPattern(from: string): RegExp | null {
  const cleaned = stripFormatCharacters(String(from ?? "")).trim();
  // Time metadata is commonly emitted as `时间: ...` or `时间：...`.
  // Treat the label as a line-level removal so the timestamp does not remain.
  if (!/^(?:时间|time)(?::|：)?$/iu.test(cleaned)) return null;
  return /^[ \t]*(?:时间|time)[ \t]*(?::|：)[^\r\n]*(?:\r?\n|$)/gimu;
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
    const linePattern = buildLineRemovalPattern(from);
    if (linePattern && String(to ?? "") === "") {
      next = next.replace(linePattern, "");
      continue;
    }
    const pattern = buildReplacementPattern(from);
    if (!pattern) continue;
    next = next.replace(pattern, () => String(to ?? ""));
  }

  return next;
}
