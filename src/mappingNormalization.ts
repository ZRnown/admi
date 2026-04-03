import { randomUUID } from "crypto";

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

export function normalizeDiscordMappingRule(input: any) {
  return {
    id: typeof input?.id === "string" ? input.id : randomUUID(),
    sourceChannelId: typeof input?.sourceChannelId === "string" ? input.sourceChannelId : "",
    sourceGuildId: normalizeOptionalTrimmedString(input?.sourceGuildId),
    sourceGuildName: normalizeOptionalTrimmedString(input?.sourceGuildName),
    sourceChannelName: normalizeOptionalTrimmedString(input?.sourceChannelName),
    targetWebhookUrl: typeof input?.targetWebhookUrl === "string" ? input.targetWebhookUrl : "",
    targetChannelId: normalizeOptionalTrimmedString(input?.targetChannelId),
    targetGuildId: normalizeOptionalTrimmedString(input?.targetGuildId),
    discordSenderType: normalizeOptionalDiscordSenderType(input?.discordSenderType),
    discordSenderAccountId: normalizeOptionalTrimmedString(input?.discordSenderAccountId),
    dingtalkSecret: normalizeOptionalTrimmedString(input?.dingtalkSecret),
    inputMode: normalizeOptionalInputMode(input?.inputMode),
    note: typeof input?.note === "string" ? input.note : undefined,
    targetWebhookName: normalizeOptionalTrimmedString(input?.targetWebhookName),
    targetWebhookAvatarUrl: normalizeOptionalTrimmedString(input?.targetWebhookAvatarUrl),
    translateDirection: normalizeOptionalTranslateDirection(input?.translateDirection),
  };
}

export function normalizeTelegramMapping(input: any) {
  const rawTarget = typeof input?.targetChannelId === "string" ? input.targetChannelId.trim() : "";
  const targetIsWebhook = /^https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(rawTarget);
  const rawType = typeof input?.type === "string" ? input.type : "";
  let normalizedType: "telegram-to-discord" | "discord-to-telegram" | "telegram-to-telegram" = "telegram-to-discord";
  if (rawType === "discord-to-telegram" || rawType === "telegram-to-discord" || rawType === "telegram-to-telegram") {
    normalizedType = rawType;
  }
  if (targetIsWebhook && normalizedType !== "telegram-to-telegram") {
    normalizedType = "telegram-to-discord";
  }

  return {
    id: typeof input?.id === "string" ? input.id : randomUUID(),
    sourceChannelId: typeof input?.sourceChannelId === "string" ? input.sourceChannelId : "",
    sourceGuildId: normalizeOptionalTrimmedString(input?.sourceGuildId),
    sourceGuildName: normalizeOptionalTrimmedString(input?.sourceGuildName),
    sourceChannelName: normalizeOptionalTrimmedString(input?.sourceChannelName),
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
