import { randomUUID } from "crypto";

const DISCORD_CHANNEL_URL_RE =
  /^https?:\/\/(?:canary\.)?discord(?:app)?\.com\/channels\/([^/]+)\/([^/]+)(?:\/([^/]+))?\/?$/i;

function normalizeOptionalTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalInputMode(value: unknown): "manual" | "select" | undefined {
  if (value === "manual" || value === "select") return value;
  return undefined;
}

function normalizeOptionalTranslateDirection(value: unknown): "off" | "auto" | "zh-en" | "en-zh" | undefined {
  return value === "off" || value === "auto" || value === "zh-en" || value === "en-zh"
    ? value
    : undefined;
}

function normalizeOptionalDiscordSenderType(value: unknown): "account" | "webhook" | undefined {
  return value === "account" || value === "webhook" ? value : undefined;
}

function normalizeDiscordSourceReference(
  sourceChannelId?: string | null,
  sourceGuildId?: string | null,
): { channelId: string; guildId?: string } {
  const channelValue = typeof sourceChannelId === "string" ? sourceChannelId.trim() : "";
  const guildValue = typeof sourceGuildId === "string" ? sourceGuildId.trim() : "";
  if (!channelValue) {
    return { channelId: "", guildId: guildValue || undefined };
  }

  const match = channelValue.match(DISCORD_CHANNEL_URL_RE);
  if (!match) {
    return { channelId: channelValue, guildId: guildValue || undefined };
  }

  const [, parsedGuildId, parsedChannelId] = match;
  const guildId = guildValue || (parsedGuildId !== "@me" ? parsedGuildId : "");
  return {
    channelId: parsedChannelId,
    guildId: guildId || undefined,
  };
}

export function normalizeDiscordMappingRule(input: any) {
  const sourceRef = normalizeDiscordSourceReference(input?.sourceChannelId, input?.sourceGuildId);
  return {
    id: typeof input?.id === "string" ? input.id : randomUUID(),
    sourceChannelId: sourceRef.channelId,
    sourceGuildId: sourceRef.guildId,
    sourceGuildName: normalizeOptionalTrimmedString(input?.sourceGuildName),
    sourceChannelName: normalizeOptionalTrimmedString(input?.sourceChannelName),
    mobileClientCategoryName: normalizeOptionalTrimmedString(input?.mobileClientCategoryName),
    mobileClientChannelName: normalizeOptionalTrimmedString(input?.mobileClientChannelName),
    mobileClientChannelAvatarUrl: normalizeOptionalTrimmedString(input?.mobileClientChannelAvatarUrl),
    targetWebhookUrl: typeof input?.targetWebhookUrl === "string" ? input.targetWebhookUrl : "",
    targetChannelId: normalizeOptionalTrimmedString(input?.targetChannelId),
    targetGuildId: normalizeOptionalTrimmedString(input?.targetGuildId),
    discordSenderType: normalizeOptionalDiscordSenderType(input?.discordSenderType),
    discordSenderAccountId: normalizeOptionalTrimmedString(input?.discordSenderAccountId),
    safewAccountId: normalizeOptionalTrimmedString(input?.safewAccountId),
    dingtalkSecret: normalizeOptionalTrimmedString(input?.dingtalkSecret),
    inputMode: normalizeOptionalInputMode(input?.inputMode),
    note: typeof input?.note === "string" ? input.note : undefined,
    targetWebhookName: normalizeOptionalTrimmedString(input?.targetWebhookName),
    targetWebhookAvatarUrl: normalizeOptionalTrimmedString(input?.targetWebhookAvatarUrl),
    translateDirection: normalizeOptionalTranslateDirection(input?.translateDirection),
  };
}

export function normalizeTelegramMapping(input: any) {
  const sourceRef = normalizeDiscordSourceReference(input?.sourceChannelId, input?.sourceGuildId);
  const rawTarget = typeof input?.targetChannelId === "string" ? input.targetChannelId.trim() : "";
  const targetIsWebhook = /^https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(rawTarget);
  const rawType = typeof input?.type === "string" ? input.type : "";
  const rawThreadId =
    typeof input?.sourceThreadId === "string"
      ? input.sourceThreadId.trim()
      : typeof input?.sourceTopicId === "string"
        ? input.sourceTopicId.trim()
        : "";
  let normalizedType:
    | "telegram-to-discord"
    | "discord-to-telegram"
    | "telegram-to-telegram"
    | "telegram-to-mobile-client" = "telegram-to-discord";
  if (
    rawType === "discord-to-telegram" ||
    rawType === "telegram-to-discord" ||
    rawType === "telegram-to-telegram" ||
    rawType === "telegram-to-mobile-client"
  ) {
    normalizedType = rawType;
  }
  if (targetIsWebhook && normalizedType !== "telegram-to-telegram") {
    normalizedType = "telegram-to-discord";
  }

  return {
    id: typeof input?.id === "string" ? input.id : randomUUID(),
    sourceChannelId: sourceRef.channelId,
    sourceGuildId: sourceRef.guildId,
    sourceGuildName: normalizeOptionalTrimmedString(input?.sourceGuildName),
    sourceChannelName: normalizeOptionalTrimmedString(input?.sourceChannelName),
    mobileClientCategoryName: normalizeOptionalTrimmedString(input?.mobileClientCategoryName),
    mobileClientChannelName: normalizeOptionalTrimmedString(input?.mobileClientChannelName),
    mobileClientChannelAvatarUrl: normalizeOptionalTrimmedString(input?.mobileClientChannelAvatarUrl),
    sourceThreadId: rawThreadId || undefined,
    targetChannelId: rawTarget,
    type: normalizedType,
    inputMode: normalizeOptionalInputMode(input?.inputMode),
    note: typeof input?.note === "string" ? input.note : undefined,
    translate: input?.translate === true,
    translateDirection: normalizeOptionalTranslateDirection(input?.translateDirection) || "auto",
    senderAccountType: input?.senderAccountType === "bot" ? "bot" : input?.senderAccountType === "client" ? "client" : undefined,
    discordSenderType: normalizeOptionalDiscordSenderType(input?.discordSenderType),
    discordSenderAccountId: normalizeOptionalTrimmedString(input?.discordSenderAccountId),
    targetGuildId: normalizeOptionalTrimmedString(input?.targetGuildId),
  };
}
