import type { AccountConfig, MultiConfig } from "./config";

export type DiscordSendAccountRef = {
  id: string;
  type: "bot" | "selfbot";
  token: string;
  name?: string;
};

function normalizeDiscordToken(raw?: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("bot ")) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

function toDiscordSendAccountRef(account: {
  id?: string;
  token?: string;
  type?: "bot" | "selfbot";
  name?: string;
  remark?: string;
} | null | undefined): DiscordSendAccountRef | null {
  if (!account?.id) return null;
  const token = normalizeDiscordToken(account.token);
  if (!token) return null;
  return {
    id: account.id,
    type: account.type === "bot" ? "bot" : "selfbot",
    token,
    name: account.remark || account.name,
  };
}

export function resolveDiscordSendAccountRef(
  config: MultiConfig | null | undefined,
  sourceAccount: AccountConfig | null | undefined,
  senderAccountId?: string | null,
): DiscordSendAccountRef | null {
  const normalizedSenderAccountId = String(senderAccountId || "").trim();
  if (!normalizedSenderAccountId) return null;

  if (sourceAccount?.id === normalizedSenderAccountId) {
    return toDiscordSendAccountRef(sourceAccount);
  }

  const instanceAccount = (config?.accounts || []).find((account) => account.id === normalizedSenderAccountId);
  const resolvedInstance = toDiscordSendAccountRef(instanceAccount);
  if (resolvedInstance) return resolvedInstance;

  const libraryAccount = (config?.discordAccounts || []).find((account) => account.id === normalizedSenderAccountId);
  return toDiscordSendAccountRef(libraryAccount);
}
