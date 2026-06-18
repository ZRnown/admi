import { buildMobileClientIngestPayload, sendMobileClientMessage } from "./mobileClientBridge";

type MobileTarget = {
  enabled?: boolean;
  endpoint?: string;
  adminToken?: string;
  guildId?: string;
  guildName?: string;
};

const DEFAULT_MOBILE_CLIENT_SYNC_ENDPOINT = "http://192.210.141.219:8765";
const DEFAULT_MOBILE_CLIENT_SYNC_ADMIN_TOKEN = "jujing-admin-2026";
const DEFAULT_MOBILE_CLIENT_GUILD_ID = "mobile-client";
const DEFAULT_MOBILE_CLIENT_GUILD_NAME = "手机客户端";

function normalizeValue(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolveMobileClientTarget(target?: MobileTarget | null): Required<MobileTarget> | null {
  if (target?.enabled !== true) return null;
  const endpoint = normalizeValue(
    target.endpoint,
    process.env.MOBILE_CLIENT_SYNC_ENDPOINT || DEFAULT_MOBILE_CLIENT_SYNC_ENDPOINT,
  ).replace(/\/+$/, "");
  const adminToken = normalizeValue(
    target.adminToken,
    process.env.MOBILE_CLIENT_SYNC_ADMIN_TOKEN || DEFAULT_MOBILE_CLIENT_SYNC_ADMIN_TOKEN,
  );
  if (!endpoint || !adminToken) return null;
  return {
    enabled: true,
    endpoint,
    adminToken,
    guildId: normalizeValue(target.guildId, DEFAULT_MOBILE_CLIENT_GUILD_ID),
    guildName: normalizeValue(target.guildName, DEFAULT_MOBILE_CLIENT_GUILD_NAME),
  };
}

function normalizeCategoryId(value: unknown, fallback: string): string {
  const text = normalizeValue(value);
  if (!text) return fallback;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

export function shouldEnableMobileClientTarget(target?: MobileTarget | null): boolean {
  return Boolean(resolveMobileClientTarget(target));
}

export async function forwardDiscordMessageToMobileClient(
  target: MobileTarget | undefined,
  input: {
    channelId: string;
    channelName?: string;
    channelAvatarUrl?: string;
    guildId?: string;
    guildName?: string;
    categoryName?: string;
    messageId: string;
    author?: string;
    authorId?: string;
    authorAvatarUrl?: string;
    content?: string;
    createdAt?: string;
    attachments?: Array<{
      id?: string;
      url?: string;
      filename?: string;
      contentType?: string;
      size?: number;
      width?: number;
      height?: number;
    }>;
    embeds?: any[];
    reference?: any;
  },
) {
  const resolvedTarget = resolveMobileClientTarget(target);
  if (!resolvedTarget) return null;
  const payload = buildMobileClientIngestPayload({
    source: "discord",
    guildId: input.guildId || resolvedTarget.guildId,
    guildName: input.guildName || resolvedTarget.guildName,
    categoryId: normalizeCategoryId(input.categoryName, input.guildId || resolvedTarget.guildId || "discord"),
    categoryName: input.categoryName,
    channelId: input.channelId,
    channelName: input.channelName,
    channelAvatarUrl: input.channelAvatarUrl,
    messageId: input.messageId,
    author: input.author,
    authorId: input.authorId,
    authorAvatarUrl: input.authorAvatarUrl,
    content: input.content,
    createdAt: input.createdAt,
    attachments: input.attachments,
    embeds: input.embeds,
    reference: input.reference,
  });
  return sendMobileClientMessage(
    {
      endpoint: resolvedTarget.endpoint,
      adminToken: resolvedTarget.adminToken,
      payload,
    },
  );
}

export async function forwardTelegramMessageToMobileClient(
  target: MobileTarget | undefined,
  input: {
    channelId: string;
    channelName?: string;
    channelAvatarUrl?: string;
    guildId?: string;
    guildName?: string;
    categoryName?: string;
    messageId: string;
    author?: string;
    authorId?: string;
    authorAvatarUrl?: string;
    content?: string;
    createdAt?: string;
    attachments?: Array<{
      id?: string;
      url?: string;
      filename?: string;
      contentType?: string;
      size?: number;
      width?: number;
      height?: number;
    }>;
    embeds?: any[];
    reference?: any;
  },
) {
  const resolvedTarget = resolveMobileClientTarget(target);
  if (!resolvedTarget) return null;
  const payload = buildMobileClientIngestPayload({
    source: "telegram",
    guildId: input.guildId || resolvedTarget.guildId,
    guildName: input.guildName || resolvedTarget.guildName,
    categoryId: normalizeCategoryId(input.categoryName, input.guildId || resolvedTarget.guildId || "telegram"),
    categoryName: input.categoryName,
    channelId: input.channelId,
    channelName: input.channelName,
    channelAvatarUrl: input.channelAvatarUrl,
    messageId: input.messageId,
    author: input.author,
    authorId: input.authorId,
    authorAvatarUrl: input.authorAvatarUrl,
    content: input.content,
    createdAt: input.createdAt,
    attachments: input.attachments,
    embeds: input.embeds,
    reference: input.reference,
  });
  return sendMobileClientMessage(
    {
      endpoint: resolvedTarget.endpoint,
      adminToken: resolvedTarget.adminToken,
      payload,
    },
  );
}
