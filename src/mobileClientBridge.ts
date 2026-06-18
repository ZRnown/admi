export interface MobileClientAttachmentInput {
  id?: string;
  url?: string;
  filename?: string;
  name?: string;
  contentType?: string;
  content_type?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface MobileClientReferenceInput {
  messageId?: string;
  message_id?: string;
  channelId?: string;
  channel_id?: string;
  author?: string;
  authorAvatarUrl?: string;
  author_avatar_url?: string;
  content?: string;
  attachments?: MobileClientAttachmentInput[];
  embeds?: any[];
}

export interface MobileClientMessageInput {
  source: "discord" | "telegram" | string;
  guildId?: string;
  guildName?: string;
  categoryId?: string;
  categoryName?: string;
  channelId: string;
  channelName?: string;
  channelAvatarUrl?: string;
  messageId: string;
  author?: string;
  authorId?: string;
  authorAvatarUrl?: string;
  content?: string;
  createdAt?: string;
  attachments?: MobileClientAttachmentInput[];
  embeds?: any[];
  reference?: MobileClientReferenceInput | null;
}

export interface MobileClientIngestPayload {
  source: string;
  guild_id: string;
  guild_name: string;
  category_id: string;
  category_name: string;
  channel_id: string;
  channel_name: string;
  channel_avatar_url: string;
  message: {
    id: string;
    author: string;
    author_id: string;
    author_avatar_url: string;
    content: string;
    created_at: string;
    attachments: Array<{
      id: string;
      url: string;
      filename: string;
      content_type: string;
      size?: number;
      width?: number;
      height?: number;
    }>;
    embeds: any[];
    reference?: {
      message_id: string;
      channel_id: string;
      author: string;
      author_avatar_url: string;
      content: string;
      attachments: MobileClientAttachmentInput[];
      embeds: any[];
    } | null;
  };
}

export interface SendMobileClientMessageOptions {
  endpoint: string;
  adminToken: string;
  payload: MobileClientIngestPayload;
}

type FetchLike = (url: string, init: any) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json?: () => Promise<any>;
}>;

function clean(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function cleanRemoteUrl(value: unknown): string {
  const url = clean(value);
  return /^https?:\/\//i.test(url) ? url : "";
}

function normalizeAttachment(raw: MobileClientAttachmentInput) {
  const url = cleanRemoteUrl(raw.url);
  const filename = clean(raw.filename || raw.name, "file");
  if (!url) return null;
  return {
    id: clean(raw.id || url || filename),
    url,
    filename,
    content_type: clean(raw.contentType || raw.content_type),
    size: raw.size,
    width: raw.width,
    height: raw.height,
  };
}

function normalizeReference(raw?: MobileClientReferenceInput | null) {
  if (!raw) return null;
  return {
    message_id: clean(raw.messageId || raw.message_id),
    channel_id: clean(raw.channelId || raw.channel_id),
    author: clean(raw.author),
    author_avatar_url: cleanRemoteUrl(raw.authorAvatarUrl || raw.author_avatar_url),
    content: clean(raw.content),
    attachments: Array.isArray(raw.attachments) ? raw.attachments.map(normalizeAttachment).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [],
    embeds: Array.isArray(raw.embeds) ? raw.embeds : [],
  };
}

export function buildMobileClientIngestPayload(input: MobileClientMessageInput): MobileClientIngestPayload {
  const source = clean(input.source, "external");
  return {
    source,
    guild_id: clean(input.guildId, "mobile-client"),
    guild_name: clean(input.guildName, "手机客户端"),
    category_id: clean(input.categoryId, source),
    category_name: clean(input.categoryName, source === "telegram" ? "Telegram" : source === "discord" ? "Discord" : "外部消息"),
    channel_id: clean(input.channelId),
    channel_name: clean(input.channelName || input.channelId, "消息"),
    channel_avatar_url: cleanRemoteUrl(input.channelAvatarUrl),
    message: {
      id: clean(input.messageId),
      author: clean(input.author, "用户"),
      author_id: clean(input.authorId),
      author_avatar_url: cleanRemoteUrl(input.authorAvatarUrl),
      content: clean(input.content),
      created_at: clean(input.createdAt, new Date().toISOString()),
      attachments: Array.isArray(input.attachments) ? input.attachments.map(normalizeAttachment).filter((item): item is NonNullable<typeof item> => Boolean(item)) : [],
      embeds: Array.isArray(input.embeds) ? input.embeds : [],
      reference: normalizeReference(input.reference),
    },
  };
}

export async function sendMobileClientMessage(
  options: SendMobileClientMessageOptions,
  fetchImpl: FetchLike = fetch as FetchLike,
): Promise<any> {
  const endpoint = clean(options.endpoint).replace(/\/+$/, "");
  const adminToken = clean(options.adminToken);
  if (!endpoint) throw new Error("Mobile client endpoint is not configured");
  if (!adminToken) throw new Error("Mobile client admin token is not configured");

  const response = await fetchImpl(`${endpoint}/ingest/message`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-token": adminToken,
    },
    body: JSON.stringify(options.payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Mobile client ingest failed ${response.status}: ${body}`);
  }
  if (typeof response.json === "function") {
    return response.json();
  }
  const body = await response.text();
  return body ? JSON.parse(body) : {};
}
