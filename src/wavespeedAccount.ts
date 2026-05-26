export interface WaveSpeedBalanceSummary {
  remainingCredits?: number;
  planName?: string;
}

function visitObject(
  value: unknown,
  visitor: (record: Record<string, unknown>) => boolean,
  depth = 0,
): boolean {
  if (depth > 5 || value == null) {
    return false;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (visitObject(item, visitor, depth + 1)) {
        return true;
      }
    }
    return false;
  }
  if (typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (visitor(record)) {
    return true;
  }
  for (const nested of Object.values(record)) {
    if (visitObject(nested, visitor, depth + 1)) {
      return true;
    }
  }
  return false;
}

function readNumericCandidate(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readStringCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function findNumericField(payload: unknown, preferredKeys: string[]): number | undefined {
  let result: number | undefined;
  visitObject(payload, (record) => {
    for (const key of preferredKeys) {
      if (!(key in record)) {
        continue;
      }
      const candidate = readNumericCandidate(record[key]);
      if (candidate !== undefined) {
        result = candidate;
        return true;
      }
    }
    return false;
  });
  return result;
}

function findStringField(payload: unknown, preferredKeys: string[]): string | undefined {
  let result: string | undefined;
  visitObject(payload, (record) => {
    for (const key of preferredKeys) {
      if (!(key in record)) {
        continue;
      }
      const candidate = readStringCandidate(record[key]);
      if (candidate !== undefined) {
        result = candidate;
        return true;
      }
    }
    return false;
  });
  return result;
}

export function extractWaveSpeedBalanceSummary(payload: unknown): WaveSpeedBalanceSummary {
  return {
    remainingCredits: findNumericField(payload, [
      "remaining_credits",
      "remainingCredits",
      "credits_remaining",
      "credit_balance",
      "creditBalance",
      "available_credits",
      "availableCredits",
      "credits",
      "balance",
      "quota_remaining",
    ]),
    planName: findStringField(payload, [
      "account_level",
      "accountLevel",
      "plan_name",
      "planName",
      "tier",
      "subscription_tier",
    ]),
  };
}
