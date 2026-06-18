export const LEGACY_SAFEW_ACCOUNT_ID = "__legacy_safew__";

export interface SafewAccountOption {
  id: string;
  name: string;
  botToken: string;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getSafewAccountOptions(account: any): SafewAccountOption[] {
  const options: SafewAccountOption[] = [];
  const legacyToken = normalizeString(account?.safewBotToken);
  if (legacyToken) {
    options.push({
      id: LEGACY_SAFEW_ACCOUNT_ID,
      name: "SafeW 机器人",
      botToken: legacyToken,
    });
  }

  const rawAccounts = Array.isArray(account?.safewAccounts) ? account.safewAccounts : [];
  const seen = new Set(options.map((item) => item.id));
  for (const raw of rawAccounts) {
    const id = normalizeString(raw?.id);
    const botToken = normalizeString(raw?.botToken);
    if (!id || !botToken || seen.has(id)) continue;
    const name = normalizeString(raw?.name) || "SafeW 机器人";
    options.push({
      id,
      name,
      botToken,
    });
    seen.add(id);
  }
  return options;
}

export function resolveSafewAccountForRule(account: any, mapping: any): SafewAccountOption | undefined {
  const options = getSafewAccountOptions(account);
  const selectedId = normalizeString(mapping?.safewAccountId);
  if (selectedId) {
    return options.find((item) => item.id === selectedId);
  }
  return undefined;
}
