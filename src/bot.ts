import {
  Client as BotClient,
  Message,
  PartialMessage,
  Role,
  User,
  Channel as AnyChannel,
} from "discord.js";

import { Config, WatermarkConfig, type WatermarkCoverConfig } from "./config.js";
import { formatSize } from "./format.js";
import { SenderBot } from "./senderBot.js";
import { FeishuSender } from "./feishuSender.js";
import { DingTalkSender } from "./dingtalkSender.js";
import { SafewSender } from "./safewSender.js";
import { OCRClient } from "./ocrClient.js";
import { FileLogger } from "./logger.js";
import { getTelegramBridgeClient } from "./index.js";
import { formatKeywordGroups, matchParsedKeywordGroups, parseKeywordGroups } from "./keywordMatcher.js";
import { clampPercent, getLanguageRatio, stripLanguages } from "./languageFilter.js";
import {
  filterBlockedUploads,
  markBlockedImageUrl,
  stripAllEmbedImages,
  stripBlockedEmbedImages,
  stripUploadedEmbedImages,
} from "./ocrImageFilter.js";
import { resolveWatermarkList } from "./watermark.js";
import {
  detectTextWatermarkFromOCR,
  matchWatermarkRemovalTriggerKeywords,
  prepareImageForOcrAndForward,
  resolveWatermarkRemovalConfig,
  shouldUseOcrWatermarkDetection,
  type PreparedImageForOcrAndForward,
  type WatermarkRemovalConfig,
  type WatermarkRemovalRuntimeState,
} from "./watermarkRemoval.js";
import { resolveWatermarkCoverConfig } from "./watermarkCover.js";
import { recordForwardStat } from "./forwardStats.js";
import { applyReplacementDictionaryToEmbeds, stripEmbedText, stripEmbedTitles } from "./embedUtils.js";
import { appendDiscordComponentLinks, extractDiscordComponentLinks } from "./discordComponentLinks.js";
import { shouldSkipMessageForIgnoredImages } from "./messageFilterDecisions.js";
import { applyReplacementDictionary } from "./replacementDictionary.js";
import { forwardDiscordMessageToMobileClient } from "./mobileClientForwarder.js";
import { promises as fs } from "node:fs";
import path from "node:path";

interface RenderOutput {
  content: string;
}

interface TargetMessageRef {
  channelId: string;
  messageId: string;
}

interface SourceMessageMapping extends TargetMessageRef {
  timestamp: number;
  targets?: TargetMessageRef[];
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)(?:$|[?#])/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|flv)(?:$|[?#])/i;
const AUDIO_EXT_RE = /\.(mp3|wav|ogg|flac|m4a|aac)(?:$|[?#])/i;
const DOCUMENT_EXT_RE = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|rtf)(?:$|[?#])/i;
const DISCORD_URL_SOURCE = String.raw`https?:\/\/(?:[a-z0-9-]+\.)?(?:discord(?:app)?\.com|discord\.gg)\/[^\s)>]+`;
const DISCORD_MARKDOWN_LINK_RE = new RegExp(String.raw`\[([^\]]+)\]\((${DISCORD_URL_SOURCE})\)`, "giu");
const DISCORD_URL_RE = new RegExp(DISCORD_URL_SOURCE, "giu");
const DISCORD_SINGLE_URL_RE = new RegExp(DISCORD_URL_SOURCE, "iu");

function hideDiscordLinksInText(value: string): string {
  return value
    .replace(DISCORD_MARKDOWN_LINK_RE, "$1")
    .replace(DISCORD_URL_RE, "")
    .replace(/[ \t]+$/gmu, "");
}

function hideDiscordLinksInEmbeds(embeds: any[] | undefined): any[] | undefined {
  if (!embeds) return embeds;
  return embeds.map((embed) => {
    if (!embed || typeof embed !== "object") return embed;
    return {
      ...embed,
      title: typeof embed.title === "string" ? hideDiscordLinksInText(embed.title) : embed.title,
      description:
        typeof embed.description === "string" ? hideDiscordLinksInText(embed.description) : embed.description,
      url: typeof embed.url === "string" && DISCORD_SINGLE_URL_RE.test(embed.url) ? undefined : embed.url,
      fields: Array.isArray(embed.fields)
        ? embed.fields.map((field: any) => ({
            ...field,
            name: typeof field?.name === "string" ? hideDiscordLinksInText(field.name) : field?.name,
            value: typeof field?.value === "string" ? hideDiscordLinksInText(field.value) : field?.value,
          }))
        : embed.fields,
    };
  });
}

function buildSenderNameKeywordHaystack(message: Message, isWebhook: boolean, webhookName?: string): string {
  const pieces: string[] = [];
  const seen = new Set<string>();
  const push = (value: any) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    pieces.push(text);
  };
  const anyMessage = message as any;
  const anyAuthor = message.author as any;
  const anyMember = message.member as any;
  if (isWebhook) {
    push(webhookName);
    push(anyMessage.webhook?.name);
    push(anyMessage.username);
  }
  push(anyMember?.displayName);
  push(anyMember?.nickname);
  push(anyAuthor?.globalName);
  push(anyAuthor?.displayName);
  push(anyAuthor?.username);
  push(anyAuthor?.tag);
  return pieces.join("\n");
}

type FeishuRuntimeSender = {
  sender: FeishuSender;
  rule?: any;
};

export type Client<Ready extends boolean = boolean> = BotClient<Ready>;

export interface BridgeDiscordMessagePayload {
  accountId?: string;
  eventType?: string;
  id: string;
  channelId: string;
  guildId?: string;
  content?: string;
  createdTimestamp?: number;
  type?: number;
  system?: boolean;
  webhookId?: string | null;
  author?: {
    id?: string;
    username?: string;
    displayName?: string;
    tag?: string;
    bot?: boolean;
    avatarUrl?: string;
  };
  member?: {
    displayName?: string;
    roles?: Array<{ id: string; name?: string }>;
  };
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
  components?: any[];
  mentions?: {
    users?: Array<{ id: string; username?: string; displayName?: string }>;
    roles?: Array<{ id: string; name?: string }>;
    channels?: Array<{ id: string; name?: string }>;
  };
  reference?: {
    messageId?: string | null;
    channelId?: string | null;
  } | null;
  referenceMessage?: {
    id?: string;
    content?: string | null;
    createdTimestamp?: number | null;
    author?: {
      id?: string;
      username?: string;
      displayName?: string;
      avatarUrl?: string | null;
    };
    member?: {
      displayName?: string | null;
    };
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
  };
}

function buildBridgeMessage(payload: BridgeDiscordMessagePayload): any {
  const authorAvatarUrl = payload.author?.avatarUrl || undefined;
  const attachments = new Map<string, any>();
  for (const att of payload.attachments || []) {
    if (!att) continue;
    const key = att.id || att.url || att.filename || `att_${attachments.size}`;
    attachments.set(key, {
      id: key,
      url: att.url,
      proxyURL: att.url,
      name: att.filename,
      contentType: att.contentType,
      size: att.size,
      width: att.width,
      height: att.height,
    });
  }

  const users = new Map<string, any>();
  const roles = new Map<string, any>();
  const channels = new Map<string, any>();
  for (const user of payload.mentions?.users || []) {
    if (!user?.id) continue;
    users.set(user.id, {
      id: user.id,
      username: user.username,
      displayName: user.displayName || user.username,
    });
  }
  for (const role of payload.mentions?.roles || []) {
    if (!role?.id) continue;
    roles.set(role.id, {
      id: role.id,
      name: role.name || role.id,
    });
  }
  for (const channel of payload.mentions?.channels || []) {
    if (!channel?.id) continue;
    const channelObj: any = {
      id: channel.id,
      name: channel.name || channel.id,
    };
    channelObj.fetch = async () => channelObj;
    channels.set(channel.id, channelObj);
  }

  const roleCache = new Map<string, any>();
  for (const role of payload.member?.roles || []) {
    if (!role?.id) continue;
    roleCache.set(role.id, { id: role.id, name: role.name || role.id });
  }

  const author = {
    id: payload.author?.id,
    username: payload.author?.username,
    tag: payload.author?.tag || payload.author?.username,
    bot: payload.author?.bot,
    avatarUrl: authorAvatarUrl,
    displayAvatarURL: () => authorAvatarUrl,
    avatarURL: () => authorAvatarUrl,
  };

  let referenceMessage: any = undefined;
  if (payload.referenceMessage) {
    const refAttachments = new Map<string, any>();
    for (const att of payload.referenceMessage.attachments || []) {
      if (!att) continue;
      const key = att.id || att.url || att.filename || `ref_att_${refAttachments.size}`;
      refAttachments.set(key, {
        id: key,
        url: att.url,
        proxyURL: att.url,
        name: att.filename,
        contentType: att.contentType,
        size: att.size,
        width: att.width,
        height: att.height,
      });
    }
    const refAuthorAvatarUrl = payload.referenceMessage.author?.avatarUrl || undefined;
    referenceMessage = {
      id: payload.referenceMessage.id,
      content: payload.referenceMessage.content || "",
      author: {
        id: payload.referenceMessage.author?.id,
        username: payload.referenceMessage.author?.username,
        tag: payload.referenceMessage.author?.username,
        displayName: payload.referenceMessage.author?.displayName || payload.referenceMessage.author?.username,
        avatarUrl: refAuthorAvatarUrl,
        displayAvatarURL: () => refAuthorAvatarUrl,
        avatarURL: () => refAuthorAvatarUrl,
      },
      member: {
        displayName: payload.referenceMessage.member?.displayName || payload.referenceMessage.author?.displayName,
      },
      attachments: refAttachments,
      embeds: payload.referenceMessage.embeds || [],
      createdTimestamp: payload.referenceMessage.createdTimestamp || undefined,
    };
  }

  const built = {
    id: payload.id,
    channelId: payload.channelId,
    content: payload.content || "",
    author,
    member: {
      displayName: payload.member?.displayName || payload.author?.displayName,
      roles: { cache: roleCache },
    },
    attachments,
    embeds: payload.embeds || [],
    components: payload.components || [],
    mentions: {
      users,
      channels,
      roles,
    },
    reference: payload.reference?.messageId
      ? { messageId: payload.reference.messageId, channelId: payload.reference.channelId }
      : undefined,
    createdTimestamp: payload.createdTimestamp,
    webhookId: payload.webhookId,
    system: payload.system,
    type: payload.type ?? 0,
  } as any;

  if (referenceMessage) {
    built.fetchReference = async () => referenceMessage;
  }

  return built;
}

function getStatsAccountId(config: any): string {
  if (config && typeof config.id === "string" && config.id.trim()) {
    return config.id.trim();
  }
  if (config && typeof config.name === "string" && config.name.trim()) {
    return config.name.trim();
  }
  return "legacy";
}

function collectEmbedText(embeds: any[]): string[] {
  const pieces: string[] = [];
  const seen = new Set<string>();
  const push = (value: any) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    pieces.push(text);
  };
  const extract = (raw: any) => {
    if (!raw || typeof raw !== "object") return;
    push((raw as any).title);
    push((raw as any).description);
    push((raw as any).footer?.text);
    push((raw as any).author?.name);
    const fields = Array.isArray((raw as any).fields) ? (raw as any).fields : [];
    for (const field of fields) {
      push(field?.name);
      push(field?.value);
    }
  };
  for (const embed of embeds || []) {
    extract(embed);
    if (embed && typeof embed === "object") {
      if ("data" in embed) extract((embed as any).data);
      if (typeof (embed as any).toJSON === "function") {
        try {
          extract((embed as any).toJSON());
        } catch {}
      }
    }
  }
  return pieces;
}

function getMessageSnapshots(message: Message): Message[] {
  const snapshots = (message as any).messageSnapshots ?? (message as any).message_snapshots;
  if (!snapshots) return [];
  if (Array.isArray(snapshots)) {
    return snapshots
      .map((snapshot: any) => (snapshot && typeof snapshot === "object" && "message" in snapshot ? snapshot.message : snapshot))
      .filter(Boolean);
  }
  if (typeof snapshots.values === "function") {
    return Array.from(snapshots.values());
  }
  return [];
}

function collectMessageTextPieces(message: Message): string[] {
  const pieces: string[] = [];
  if (message.content) {
    pieces.push(String(message.content));
  }
  pieces.push(...collectEmbedText(message.embeds || []));
  const snapshots = getMessageSnapshots(message);
  for (const snapshot of snapshots) {
    const snapshotContent = (snapshot as any)?.content;
    if (snapshotContent) {
      pieces.push(String(snapshotContent));
    }
    pieces.push(...collectEmbedText((snapshot as any)?.embeds || []));
  }
  return pieces;
}

function hasImageAttachment(attachments: any): boolean {
  if (!attachments) return false;
  const values = typeof attachments.values === "function" ? attachments.values() : Array.isArray(attachments) ? attachments : [];
  for (const att of values) {
    const contentType = String(att?.contentType || "").toLowerCase();
    const url = String(att?.url || att?.proxyURL || "").toLowerCase();
    const name = String(att?.name || "");
    if (contentType.startsWith("image/") || (url && IMAGE_EXT_RE.test(url)) || IMAGE_EXT_RE.test(name)) {
      return true;
    }
  }
  return false;
}

function collectEmbedImageUrls(embeds: any[]): string[] {
  const urls: string[] = [];
  for (const embed of embeds || []) {
    const raw = (embed && typeof embed === "object" && "data" in embed && embed.data) ? embed.data : embed;
    if (!raw || typeof raw !== "object") continue;
    const imageUrl = String((raw as any).image?.url || (raw as any).thumbnail?.url || "");
    const rawUrl = String((raw as any).url || "");
    if ((raw as any).type === "image" && (imageUrl || rawUrl)) {
      if (imageUrl) urls.push(imageUrl);
      if (rawUrl) urls.push(rawUrl);
      continue;
    }
    if (imageUrl && IMAGE_EXT_RE.test(imageUrl)) {
      urls.push(imageUrl);
    }
    if (rawUrl && IMAGE_EXT_RE.test(rawUrl)) {
      urls.push(rawUrl);
    }
  }
  return urls;
}

function hasImageInEmbeds(embeds: any[]): boolean {
  return collectEmbedImageUrls(embeds).length > 0;
}

function guessImageExtension(url: string): string {
  try {
    const ext = path.extname(new URL(url).pathname);
    if (ext && ext.length <= 8) return ext.toLowerCase();
  } catch {}
  const match = url.match(IMAGE_EXT_RE);
  if (match) return `.${match[1].toLowerCase()}`;
  return ".jpg";
}

function buildImageFilename(url: string, index: number, base?: string): string {
  const ext = guessImageExtension(url);
  const safeBase = (base || `image_${index}`).replace(/[^a-zA-Z0-9_.-]/g, "_");
  if (path.extname(safeBase)) return safeBase;
  return `${safeBase}${ext}`;
}

function replaceEmbedImageUrls(
  embeds: any[] | undefined,
  urlMap: Map<string, string>,
): any[] | undefined {
  if (!embeds || embeds.length === 0 || urlMap.size === 0) return embeds;
  const resolveAttachment = (url?: string) => {
    if (!url) return url;
    const normalized = normalizeImageUrl(url);
    const mapped = urlMap.get(url) || (normalized ? urlMap.get(normalized) : undefined);
    return mapped ? `attachment://${mapped}` : url;
  };
  return embeds.map((embed) => {
    if (!embed || typeof embed !== "object") return embed;
    let raw: any = embed;
    if (typeof (embed as any).toJSON === "function") {
      try {
        raw = (embed as any).toJSON();
      } catch {}
    } else if ("data" in embed && (embed as any).data) {
      raw = (embed as any).data;
    }
    if (!raw || typeof raw !== "object") return raw;
    const next: any = { ...raw };
    if (next.image && typeof next.image === "object") {
      next.image = { ...next.image, url: resolveAttachment(next.image.url) };
    }
    if (next.thumbnail && typeof next.thumbnail === "object") {
      next.thumbnail = { ...next.thumbnail, url: resolveAttachment(next.thumbnail.url) };
    }
    if (next.type === "image" || (typeof next.url === "string" && IMAGE_EXT_RE.test(next.url))) {
      next.url = resolveAttachment(next.url);
    }
    return next;
  });
}

function normalizeImageUrl(url?: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] || url;
  }
}

function isForwardReference(message: Message): boolean {
  const refType = message.reference?.type;
  if (refType === undefined || refType === null) return false;
  return refType === 1 || String(refType) === "FORWARD";
}

function hasForwardedImage(message: Message): boolean {
  const snapshots = getMessageSnapshots(message);
  const isForwarded = isForwardReference(message) || snapshots.length > 0;
  if (!isForwarded) return false;
  if (hasImageInEmbeds(message.embeds || [])) return true;
  for (const snapshot of snapshots) {
    if (hasImageAttachment((snapshot as any).attachments)) return true;
    if (hasImageInEmbeds((snapshot as any).embeds || [])) return true;
  }
  return false;
}

type ImageAsset = { url: string; contentType?: string; name?: string };
type PreparedImageAsset = ImageAsset &
  PreparedImageForOcrAndForward & {
    watermarkRemovalState?: WatermarkRemovalRuntimeState;
  };

function collectImageAssets(message: Message): ImageAsset[] {
  const assets: ImageAsset[] = [];
  const seen = new Set<string>();

  const addAsset = (url?: string, contentType?: string, name?: string) => {
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);
    assets.push({ url, contentType, name });
  };

  const addFromAttachments = (attachments: any) => {
    if (!attachments) return;
    const values = typeof attachments.values === "function" ? attachments.values() : Array.isArray(attachments) ? attachments : [];
    for (const att of values) {
      const contentType = String(att?.contentType || "").toLowerCase();
      const url = String(att?.url || att?.proxyURL || "");
      const name = String(att?.name || "");
      if (!url) continue;
      if (contentType.startsWith("image/") || IMAGE_EXT_RE.test(url) || IMAGE_EXT_RE.test(name)) {
        addAsset(url, contentType, att?.name);
      }
    }
  };

  addFromAttachments(message.attachments);

  const snapshots = getMessageSnapshots(message);
  for (const snapshot of snapshots) {
    addFromAttachments((snapshot as any).attachments);
  }

  const isForwarded = isForwardReference(message) || snapshots.length > 0;
  if (isForwarded) {
    for (const url of collectEmbedImageUrls(message.embeds || [])) {
      addAsset(url, undefined, undefined);
    }
    for (const snapshot of snapshots) {
      for (const url of collectEmbedImageUrls((snapshot as any).embeds || [])) {
        addAsset(url, undefined, undefined);
      }
    }
  }

  return assets;
}

function formatLogPreview(text?: string, limit = 160): string {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "(无文本内容)";
  return normalized.length > limit ? normalized.slice(0, limit) + "..." : normalized;
}

function applyLongMessageConfig(
  content: string,
  config?: { enabled?: boolean; threshold?: number; appendMessage?: string },
): string {
  if (!config?.enabled) return content;
  const threshold = typeof config.threshold === "number" ? config.threshold : 0;
  if (threshold > 0 && content.length > threshold) {
    const trimmed = content.slice(0, threshold);
    const append = typeof config.appendMessage === "string" ? config.appendMessage.trim() : "";
    return append ? `${trimmed}\n${append}` : trimmed;
  }
  return content;
}

// 简单的定长去重缓存，无定时器，高性能
class DedupeCache {
  private items = new Set<string>();
  private queue: string[] = [];
  private limit: number;

  constructor(limit = 2000) {
    this.limit = limit;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  add(id: string) {
    if (this.items.has(id)) return;
    this.items.add(id);
    this.queue.push(id);
    if (this.queue.length > this.limit) {
      const old = this.queue.shift();
      if (old) this.items.delete(old);
    }
  }
}

export class Bot {
  senderBot?: SenderBot; // default sender (可选，如果关闭 Discord 转发则为 undefined)
  private senderBotsBySource?: Map<string, SenderBot[]>;  // 支持相同源ID对应多个webhook
  private feishuSendersBySource?: Map<string, FeishuRuntimeSender[]>;
  private dingtalkSendersBySource?: Map<string, DingTalkSender[]>;
  private safewSendersBySource?: Map<string, SafewSender[]>;
  config: Config;
  client: Client;
  // 记录频道最近活跃时间（用于主备模式）
  private static channelActivity = new Map<string, number>();
  // 源消息ID -> 目标消息ID映射（用于构建目标内跳转链接）
  // 使用带大小限制的 Map，防止内存无限增长
  private sourceToTarget = new Map<string, SourceMessageMapping>();
  private mapFile = path.resolve(process.cwd(), ".data", "message_map.json");
  private logger = new FileLogger();
  // 优化：使用无定时器的去重缓存
  private processedIds = new DedupeCache(2000);
  // 连续消息去重（按源频道）
  private sequentialDedupe = new Map<string, string>();
  // Map 最大条目数，超过时删除最旧的（保留最近 10000 条映射）
  private readonly MAX_MAP_SIZE = 10000;
  // 定期保存定时器
  private saveMappingTimer?: NodeJS.Timeout;
  private attachedListeners?: {
    readyHandler: (clientArg: Client<true>) => void;
    errorHandler: (err: any) => void;
    shardErrorHandler: (err: any) => void;
    warnHandler: (info: any) => void;
    messageHandler: (message: Message) => void;
    messageUpdateHandler: (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => void;
    messageDeleteHandler: (message: Message | PartialMessage) => void;
  };
  // 标记数据是否变动，减少 I/O
  private isMappingDirty = false;
  // 记录process监听器，便于清理
  private processExitHandlers: Array<() => void> = [];
  // OCR客户端
  private ocrClient?: OCRClient;
  
  // 预编译正则
  private readonly RE_TWITTER = /^<?https?:\/\/(?:x\.com|twitter\.com)\/\S+>?$/i;
  private readonly RE_GIF = /^<?https?:\/\/(?:tenor\.com|giphy\.com)\/\S+>?$/i;
  
  constructor(
    client: Client,
    config: Config,
    senderBot: SenderBot | undefined,
    senderBotsBySource?: Map<string, SenderBot[]>,
    feishuSendersBySource?: Map<string, FeishuRuntimeSender[]>,
    dingtalkSendersBySource?: Map<string, DingTalkSender[]>,
    safewSendersBySource?: Map<string, SafewSender[]>,
    options?: { sharedClient?: boolean; externalMessageSource?: boolean },
  ) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;
    this.feishuSendersBySource = feishuSendersBySource;
    this.dingtalkSendersBySource = dingtalkSendersBySource;
    this.safewSendersBySource = safewSendersBySource;

    // 初始化OCR客户端 - 自动根据屏蔽/触发词启用/禁用
    const hasOCRKeywords = this.hasOcrFilters(config);
    if (hasOCRKeywords && config.ocrServerUrl) {
      this.ocrClient = new OCRClient(config.ocrServerUrl, undefined); // 不使用代理，直接连接
      console.log(`[Bot] ✅ OCR已自动启用（检测到OCR过滤配置），服务器URL: ${config.ocrServerUrl}`);
    } else {
      this.ocrClient = undefined;
      if (!hasOCRKeywords) {
        console.log(`[Bot] ⏸️  OCR已自动禁用（未配置OCR过滤）`);
      } else {
        console.log(`[Bot] ⏸️  OCR已自动禁用（未配置OCR服务器URL）`);
      }
    }

    const externalMessageSource = options?.externalMessageSource === true;
    const shouldResetListeners = options?.sharedClient !== true && !externalMessageSource;
    if (shouldResetListeners) {
      // 移除所有旧的事件监听器，避免重复注册
      (this.client as any).removeAllListeners?.("ready");
      (this.client as any).removeAllListeners?.("error");
      (this.client as any).removeAllListeners?.("shardError");
      (this.client as any).removeAllListeners?.("warn");
      (this.client as any).removeAllListeners?.("messageCreate");
      (this.client as any).removeAllListeners?.("messageUpdate");
      (this.client as any).removeAllListeners?.("messageDelete");
    }

    if (!externalMessageSource) {
      // 使用 clientReady 替代 ready（Discord.js v15 兼容）
      const readyHandler = (clientArg: Client<true>) => {
        const msg = `Logged into Discord as @${clientArg.user?.tag}!`;
        console.log(msg);
        this.logger.info(msg);
      };
      // 同时监听 ready 和 clientReady 以兼容不同版本
      (this.client as any).on?.("clientReady", readyHandler);
      (this.client as any).on?.("ready", readyHandler);

      // 监听客户端错误，避免 ECONNRESET 直接导致进程崩溃
      const errorHandler = (err: any) => {
        this.logger.error(`client error: ${String(err?.stack || err)}`);
      };
      const shardErrorHandler = (err: any) => {
        this.logger.error(`shard error: ${String(err?.stack || err)}`);
      };
      const warnHandler = (info: any) => {
        this.logger.debug(`client warn: ${String(info)}`);
      };
      (this.client as any).on?.("error", errorHandler);
      (this.client as any).on?.("shardError", shardErrorHandler);
      (this.client as any).on?.("warn", warnHandler);

      const messageHandler = async (message: Message) => {
        // 简化监听器：所有处理逻辑都在 processAndSend 中
        await this.processAndSend(message);
      };
      (this.client as any).on?.("messageCreate", messageHandler);

      const messageUpdateHandler = async (
        oldMessage: Message | PartialMessage,
        newMessage: Message | PartialMessage,
      ) => {
        await this.handleMessageUpdate(oldMessage, newMessage);
      };
      (this.client as any).on?.("messageUpdate", messageUpdateHandler);

      const messageDeleteHandler = async (message: Message | PartialMessage) => {
        await this.handleMessageDelete(message);
      };
      (this.client as any).on?.("messageDelete", messageDeleteHandler);

      this.attachedListeners = {
        readyHandler,
        errorHandler,
        shardErrorHandler,
        warnHandler,
        messageHandler,
        messageUpdateHandler,
        messageDeleteHandler,
      };
    }

    // 定期保存映射（每 5 分钟保存一次，只在数据变动时保存）
    this.saveMappingTimer = setInterval(() => {
      if (this.isMappingDirty) {
      this.saveMapping().catch(err => {
        this.logger.error(`定期保存映射失败: ${String(err)}`);
      });
      }
    }, 5 * 60 * 1000);

    // 程序退出时保存映射
    // 注意：不在每个 Bot 实例中添加 process 监听器，避免监听器泄漏
    // 映射会在 cleanup 时保存，或者在定时器中定期保存
    this.processExitHandlers = [];

    // 为了支持"回复可跳转"，改为单条即时发送（如需保留堆叠，可另加配置开关）
  }

  /**
   * 清理资源，停止定时器等
   */
  async cleanup() {
    if (this.saveMappingTimer) {
      clearInterval(this.saveMappingTimer);
      this.saveMappingTimer = undefined;
    }
    if (this.attachedListeners) {
      const target: any = this.client as any;
      target.off?.("clientReady", this.attachedListeners.readyHandler);
      target.off?.("ready", this.attachedListeners.readyHandler);
      target.off?.("error", this.attachedListeners.errorHandler);
      target.off?.("shardError", this.attachedListeners.shardErrorHandler);
      target.off?.("warn", this.attachedListeners.warnHandler);
      target.off?.("messageCreate", this.attachedListeners.messageHandler);
      target.off?.("messageUpdate", this.attachedListeners.messageUpdateHandler);
      target.off?.("messageDelete", this.attachedListeners.messageDeleteHandler);
      this.attachedListeners = undefined;
    }
    // 注意：process 监听器是全局的，不应该在这里移除（因为可能被其他实例使用）
    // 只在数据变动时保存映射
    if (this.isMappingDirty) {
      await this.saveMapping().catch((err) => {
        this.logger.error(`cleanup saveMapping failed: ${String(err)}`);
      });
    }
  }

  /**
   * 在不重启进程的情况下，更新运行时使用的配置和转发映射。
   * 供外部在检测到 config.json / .env 变更后调用。
   */
  updateRuntimeConfig(
    config: Config,
    defaultSender: SenderBot | undefined,
    senderBotsBySource?: Map<string, SenderBot[]>,
    feishuSendersBySource?: Map<string, FeishuRuntimeSender[]>,
    dingtalkSendersBySource?: Map<string, DingTalkSender[]>,
    safewSendersBySource?: Map<string, SafewSender[]>,
  ) {
    this.config = config;
    this.senderBot = defaultSender;
    this.senderBotsBySource = senderBotsBySource;
    this.feishuSendersBySource = feishuSendersBySource;
    this.dingtalkSendersBySource = dingtalkSendersBySource;
    this.safewSendersBySource = safewSendersBySource;

    // 更新OCR配置 - 自动根据屏蔽/触发词启用/禁用
    const hasOCRKeywords = this.hasOcrFilters(config);
    const previousHasOCR = this.ocrClient !== undefined;

    if (hasOCRKeywords && config.ocrServerUrl) {
      if (!previousHasOCR) {
        this.ocrClient = new OCRClient(config.ocrServerUrl, undefined); // 不使用代理，直接连接
        console.log(`[Bot] ✅ OCR已自动启用（检测到OCR过滤配置）`);
      }
    } else {
      if (previousHasOCR) {
        this.ocrClient = undefined;
        if (!hasOCRKeywords) {
          console.log(`[Bot] ⏸️  OCR已自动禁用（未配置OCR过滤）`);
        } else {
          console.log(`[Bot] ⏸️  OCR已自动禁用（未配置OCR服务器URL）`);
        }
      }
    }

    this.logger.info("runtime config updated: channelWebhooks / blockedKeywords / OCR 已刷新");
  }

  setSelfUser(user?: { id?: string; username?: string; tag?: string; displayName?: string }) {
    if (!user) return;
    const tag = user.tag || user.username || user.displayName;
    (this.client as any).user = {
      id: user.id,
      username: user.username || user.displayName,
      tag,
    };
  }

  async handleExternalMessage(payload: BridgeDiscordMessagePayload) {
    const message = buildBridgeMessage(payload);
    await this.processAndSend(message);
  }

  async handleExternalMessageUpdate(payload: BridgeDiscordMessagePayload) {
    const message = buildBridgeMessage(payload);
    await this.handleMessageUpdate(message as any, message as any);
  }

  async handleExternalMessageDelete(payload: BridgeDiscordMessagePayload) {
    const message = buildBridgeMessage(payload);
    await this.handleMessageDelete(message as any);
  }

  private getSendersForChannel(channelId: string): SenderBot[] {
    return this.senderBotsBySource?.get(channelId) || [];
  }

  private hasOcrFilters(config: Config): boolean {
    if ((config.ocrBlockedKeywords?.length || 0) > 0 || (config.ocrTriggerKeywords?.length || 0) > 0) {
      return true;
    }
    if (shouldUseOcrWatermarkDetection(resolveWatermarkRemovalConfig((config as any).watermarkRemoval))) {
      return true;
    }
    const hasRuleOcr = (rule: any) =>
      (rule?.ocrBlockedKeywords?.length || 0) > 0 ||
      (rule?.ocrTriggerKeywords?.length || 0) > 0 ||
      shouldUseOcrWatermarkDetection(resolveWatermarkRemovalConfig((config as any).watermarkRemoval, rule?.watermarkRemoval));
    const mappings = (config as any).mappings || [];
    for (const rule of mappings) {
      if (hasRuleOcr(rule)) return true;
    }
    const telegramMappings = (config as any).telegramConfig?.mappings || [];
    for (const rule of telegramMappings) {
      if (hasRuleOcr(rule)) return true;
    }
    const feishuMappings = (config as any).feishuMappings || [];
    for (const rule of feishuMappings) {
      if (hasRuleOcr(rule)) return true;
    }
    const feishuRuleConfigs = (config as any).feishuRuleConfigs || {};
    for (const rule of Object.values(feishuRuleConfigs)) {
      if (hasRuleOcr(rule)) return true;
    }
    return false;
  }

  private getFeishuSendersForChannel(channelId: string): FeishuRuntimeSender[] {
    return this.feishuSendersBySource?.get(channelId) || [];
  }

  private getDingTalkSendersForChannel(channelId: string): DingTalkSender[] {
    return this.dingtalkSendersBySource?.get(channelId) || [];
  }

  private getSafewSendersForChannel(channelId: string): SafewSender[] {
    return this.safewSendersBySource?.get(channelId) || [];
  }

  private shouldSendToRuleTarget(options: {
    rule?: any;
    message: Message;
    isWebhook: boolean;
    senderNameHay: string;
    textHay: string;
    hasTextForKeywords: boolean;
    caseInsensitive: boolean;
    logPrefix: string;
    targetLabel: string;
  }): boolean {
    const { rule, message, isWebhook, senderNameHay, textHay, hasTextForKeywords, caseInsensitive, logPrefix, targetLabel } = options;
    if (!rule || typeof rule !== "object") return true;
    const authorId = message.author?.id;
    if (!isWebhook && authorId) {
      const mutedUsers = (rule.mutedUsersIds || []).map((x: any) => String(x)).filter(Boolean);
      if (mutedUsers.length > 0 && mutedUsers.includes(authorId)) {
        this.logger.info(`${logPrefix} [FEISHU] 跳过目标 ${targetLabel}: 作者在该规则黑名单`);
        return false;
      }
      const allowedUsers = (rule.allowedUsersIds || []).map((x: any) => String(x)).filter(Boolean);
      if (allowedUsers.length > 0 && !allowedUsers.includes(authorId)) {
        this.logger.info(`${logPrefix} [FEISHU] 跳过目标 ${targetLabel}: 作者不在该规则白名单`);
        return false;
      }
    }
    const blockedSenderNameGroups = parseKeywordGroups(rule.blockedSenderNameKeywords || rule.blockedAuthorNameKeywords);
    if (blockedSenderNameGroups.length > 0) {
      const { matchedGroups } = matchParsedKeywordGroups(senderNameHay, blockedSenderNameGroups, { caseInsensitive });
      if (matchedGroups.length > 0) {
        this.logger.info(`${logPrefix} [FEISHU] 跳过目标 ${targetLabel}: 命中发送人名字屏蔽关键词 ${formatKeywordGroups(matchedGroups)}`);
        return false;
      }
    }
    const allowedSenderNameGroups = parseKeywordGroups(rule.allowedSenderNameKeywords);
    if (allowedSenderNameGroups.length > 0) {
      const { matchedGroups } = matchParsedKeywordGroups(senderNameHay, allowedSenderNameGroups, { caseInsensitive });
      if (matchedGroups.length === 0) {
        this.logger.info(`${logPrefix} [FEISHU] 跳过目标 ${targetLabel}: 未命中只发送发送人名字关键词`);
        return false;
      }
    }
    if (hasTextForKeywords) {
      const blockedGroups = parseKeywordGroups(rule.blockedKeywords);
      if (blockedGroups.length > 0) {
        const { matchedGroups } = matchParsedKeywordGroups(textHay, blockedGroups, { caseInsensitive });
        if (matchedGroups.length === 0) {
          this.logger.info(`${logPrefix} [FEISHU] 跳过目标 ${targetLabel}: 未命中该规则触发关键词`);
          return false;
        }
      }
      const excludeGroups = parseKeywordGroups(rule.excludeKeywords);
      if (excludeGroups.length > 0) {
        const { matchedGroups } = matchParsedKeywordGroups(textHay, excludeGroups, { caseInsensitive });
        if (matchedGroups.length > 0) {
          this.logger.info(`${logPrefix} [FEISHU] 跳过目标 ${targetLabel}: 命中该规则屏蔽关键词 ${formatKeywordGroups(matchedGroups)}`);
          return false;
        }
      }
    }
    return true;
  }

  private normalizeTargets(targets: TargetMessageRef[] | undefined): TargetMessageRef[] {
    if (!Array.isArray(targets) || targets.length === 0) return [];
    const unique = new Map<string, TargetMessageRef>();
    for (const target of targets) {
      const channelId = String(target?.channelId || "").trim();
      const messageId = String(target?.messageId || "").trim();
      if (!channelId || !messageId) continue;
      unique.set(`${channelId}:${messageId}`, { channelId, messageId });
    }
    return Array.from(unique.values());
  }

  private getMappedTargets(sourceMessageId: string): TargetMessageRef[] {
    const entry = this.sourceToTarget.get(sourceMessageId);
    if (!entry) return [];
    const fromTargets = this.normalizeTargets(entry.targets);
    if (fromTargets.length > 0) return fromTargets;
    if (entry.channelId && entry.messageId) {
      return [{ channelId: entry.channelId, messageId: entry.messageId }];
    }
    return [];
  }

  private setSourceMapping(sourceMessageId: string, targets: TargetMessageRef[]) {
    const normalized = this.normalizeTargets(targets);
    if (normalized.length === 0) return;
    const first = normalized[0];
    if (this.sourceToTarget.has(sourceMessageId)) {
      this.sourceToTarget.delete(sourceMessageId);
    }
    this.sourceToTarget.set(sourceMessageId, {
      channelId: first.channelId,
      messageId: first.messageId,
      targets: normalized,
      timestamp: Date.now(),
    });
    this.limitMapSize();
    this.isMappingDirty = true;
  }

  private buildSequentialSignature(message: Message): string {
    const text = collectMessageTextPieces(message)
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .join("\n");
    const attachmentKeys: string[] = [];
    if (message.attachments && message.attachments.size > 0) {
      for (const att of message.attachments.values()) {
        attachmentKeys.push(att.url || att.name || "");
      }
    }
    const attachments = attachmentKeys.join("|");
    const embeds = message.embeds?.length || 0;
    const componentLinks = extractDiscordComponentLinks((message as any).components)
      .map((link) => `${link.label}:${link.url}`)
      .join("|");
    return `${text}||att:${attachments}||emb:${embeds}||components:${componentLinks}`;
  }

  /**
   * 获取指定频道的规则级别完整配置
   * 返回该频道规则的所有过滤配置
   * 同时查找顶层 mappings 和 telegramConfig.mappings
   */
  private getRuleLevelConfig(channelId: string): {
    allowedUsersIds: string[];
    mutedUsersIds: string[];
    allowedSenderNameKeywords: string[];
    blockedSenderNameKeywords: string[];
    blockedKeywords: string[];
    excludeKeywords: string[];
    ocrBlockedKeywords: string[];
    ocrTriggerKeywords: string[];
    longMessage?: {
      enabled: boolean;
      threshold?: number;
      appendMessage?: string;
    };
    replacementsDictionary: Record<string, string>;
    showSourceIdentity?: boolean;
    hideDiscordLinks?: boolean;
    ignoreSelf?: boolean;
    ignoreBot?: boolean;
    onlyBot?: boolean;
    ignoreImages?: boolean;
    ignoreAudio?: boolean;
    ignoreVideo?: boolean;
    ignoreDocuments?: boolean;
    ignoreEnglish?: boolean;
    ignoreEnglishThreshold?: number;
    ignoreChinese?: boolean;
    ignoreChineseThreshold?: number;
    stripEnglish?: boolean;
    stripChinese?: boolean;
    watermark?: WatermarkConfig;
    watermarkSecondary?: WatermarkConfig;
    watermarks?: WatermarkConfig[];
    watermarkRemoval?: WatermarkRemovalConfig;
    watermarkCover?: WatermarkCoverConfig;
    standbyMode?: {
      enabled: boolean;
      mainChannelId: string;
      cooldownSeconds: number;
    };
    mobileClientCategoryName?: string;
    mobileClientChannelName?: string;
    mobileClientChannelAvatarUrl?: string;
  } {
    // 查找顶层 mappings（Discord->Discord 规则）
    const mappings = (this.config as any).mappings || [];
    let rule = mappings.find((m: any) => m.sourceChannelId === channelId);

    // 如果顶层没找到，查找 telegramConfig.mappings（Discord->Telegram 规则）
    if (!rule) {
      const telegramMappings = (this.config as any).telegramConfig?.mappings || [];
      rule = telegramMappings.find((m: any) => m.sourceChannelId === channelId);
    }

    // 如果还没找到，查找 feishuRuleConfigs（Discord->Feishu 规则）
    if (!rule) {
      const feishuMappings = (this.config as any).feishuMappings || [];
      rule = feishuMappings.find((m: any) => m.sourceChannelId === channelId);
    }

    // 如果还没找到，查找旧版 feishuRuleConfigs（Discord->Feishu 规则）
    if (!rule) {
      const feishuRuleConfigs = (this.config as any).feishuRuleConfigs || {};
      rule = feishuRuleConfigs[channelId];
    }

    if (!rule) {
      return {
        allowedUsersIds: [],
        mutedUsersIds: [],
        allowedSenderNameKeywords: [],
        blockedSenderNameKeywords: [],
        blockedKeywords: [],
        excludeKeywords: [],
        ocrBlockedKeywords: [],
        ocrTriggerKeywords: [],
        longMessage: undefined,
        replacementsDictionary: {},
        showSourceIdentity: undefined,
        hideDiscordLinks: undefined,
        ignoreSelf: undefined,
        ignoreBot: undefined,
        onlyBot: undefined,
        ignoreImages: undefined,
        ignoreAudio: undefined,
        ignoreVideo: undefined,
        ignoreDocuments: undefined,
        ignoreEnglish: undefined,
        ignoreEnglishThreshold: undefined,
        ignoreChinese: undefined,
        ignoreChineseThreshold: undefined,
        stripEnglish: undefined,
        stripChinese: undefined,
        watermark: undefined,
        watermarkSecondary: undefined,
        watermarks: undefined,
        watermarkRemoval: undefined,
        watermarkCover: undefined,
        standbyMode: undefined,
        mobileClientCategoryName: undefined,
        mobileClientChannelName: undefined,
        mobileClientChannelAvatarUrl: undefined,
      };
    }
    return {
      allowedUsersIds: (rule.allowedUsersIds || []).map((x: any) => String(x)).filter(Boolean),
      mutedUsersIds: (rule.mutedUsersIds || []).map((x: any) => String(x)).filter(Boolean),
      allowedSenderNameKeywords: (rule.allowedSenderNameKeywords || []).map((x: any) => String(x)).filter(Boolean),
      blockedSenderNameKeywords: (rule.blockedSenderNameKeywords || rule.blockedAuthorNameKeywords || []).map((x: any) => String(x)).filter(Boolean),
      blockedKeywords: (rule.blockedKeywords || []).filter(Boolean),
      excludeKeywords: (rule.excludeKeywords || []).filter(Boolean),
      ocrBlockedKeywords: (rule.ocrBlockedKeywords || []).filter(Boolean),
      ocrTriggerKeywords: (rule.ocrTriggerKeywords || []).filter(Boolean),
      longMessage:
        rule.longMessage && typeof rule.longMessage === "object"
          ? {
              enabled: rule.longMessage.enabled === true,
              threshold: typeof rule.longMessage.threshold === "number" ? rule.longMessage.threshold : undefined,
              appendMessage:
                typeof rule.longMessage.appendMessage === "string" ? rule.longMessage.appendMessage : undefined,
            }
          : undefined,
      replacementsDictionary: rule.replacementsDictionary || {},
      showSourceIdentity: rule.showSourceIdentity,
      hideDiscordLinks: rule.hideDiscordLinks,
      ignoreSelf: rule.ignoreSelf,
      ignoreBot: rule.ignoreBot,
      onlyBot: rule.onlyBot,
      ignoreImages: rule.ignoreImages,
      ignoreAudio: rule.ignoreAudio,
      ignoreVideo: rule.ignoreVideo,
      ignoreDocuments: rule.ignoreDocuments,
      ignoreEnglish: rule.ignoreEnglish,
      ignoreEnglishThreshold: rule.ignoreEnglishThreshold,
      ignoreChinese: rule.ignoreChinese,
      ignoreChineseThreshold: rule.ignoreChineseThreshold,
      stripEnglish: rule.stripEnglish,
      stripChinese: rule.stripChinese,
      watermark: rule.watermark,
      watermarkSecondary: rule.watermarkSecondary,
      watermarks: rule.watermarks,
      watermarkRemoval: rule.watermarkRemoval,
      watermarkCover: rule.watermarkCover,
      standbyMode: rule.standbyMode,
      mobileClientCategoryName:
        typeof rule.mobileClientCategoryName === "string" && rule.mobileClientCategoryName.trim()
          ? rule.mobileClientCategoryName.trim()
          : undefined,
      mobileClientChannelName:
        typeof rule.mobileClientChannelName === "string" && rule.mobileClientChannelName.trim()
          ? rule.mobileClientChannelName.trim()
          : undefined,
      mobileClientChannelAvatarUrl:
        typeof rule.mobileClientChannelAvatarUrl === "string" && rule.mobileClientChannelAvatarUrl.trim()
          ? rule.mobileClientChannelAvatarUrl.trim()
          : undefined,
    };
  }

  private async ensureDataDir() {
    const dir = path.dirname(this.mapFile);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      this.logger.error(`ensureDataDir failed: ${String(e)}`);
    }
  }

  private async loadMapping() {
    try {
      await this.ensureDataDir();
      const buf = await fs.readFile(this.mapFile, "utf-8");
      const json = JSON.parse(buf) as Record<
        string,
        { channelId?: string; messageId?: string; timestamp?: number; targets?: TargetMessageRef[] }
      >;
      const now = Date.now();
      // 加载时添加时间戳（如果旧数据没有时间戳，使用当前时间）
      const entries = Object.entries(json)
        .map(([key, value]): [string, SourceMessageMapping] | null => {
          const normalizedTargets = this.normalizeTargets([
            ...(Array.isArray(value.targets) ? value.targets : []),
            ...(value.channelId && value.messageId
              ? [{ channelId: String(value.channelId), messageId: String(value.messageId) }]
              : []),
          ]);
          if (normalizedTargets.length === 0) return null;
          const first = normalizedTargets[0];
          return [
            key,
            {
              channelId: first.channelId,
              messageId: first.messageId,
              targets: normalizedTargets,
              timestamp: value.timestamp || now,
            },
          ];
        })
        .filter((entry): entry is [string, SourceMessageMapping] => !!entry);
      // 只保留最近的 MAX_MAP_SIZE 条
      const sorted = entries.sort((a, b) => b[1].timestamp - a[1].timestamp);
      const limited = sorted.slice(0, this.MAX_MAP_SIZE);
      this.sourceToTarget = new Map(limited);
      if (entries.length > this.MAX_MAP_SIZE) {
        this.logger.info(`Loaded ${this.MAX_MAP_SIZE} mappings (dropped ${entries.length - this.MAX_MAP_SIZE} old entries)`);
      }
    } catch {}
  }

  private async saveMapping() {
    try {
      await this.ensureDataDir();
      // 只保留最近 MAX_MAP_SIZE 条
      if (this.sourceToTarget.size > this.MAX_MAP_SIZE) {
        // Map 迭代器按插入顺序返回，删除最旧的（头部）
        const deleteCount = this.sourceToTarget.size - this.MAX_MAP_SIZE;
        const keys = this.sourceToTarget.keys();
        for (let i = 0; i < deleteCount; i++) {
          const key = keys.next().value;
          if (key) {
            this.sourceToTarget.delete(key);
          }
        }
      }
      // 只保存必要字段，不保存 timestamp（减少文件大小）
      const obj: Record<string, { channelId: string; messageId: string; targets?: TargetMessageRef[] }> = {};
      for (const [key, value] of this.sourceToTarget.entries()) {
        const normalizedTargets = this.normalizeTargets(
          value.targets && value.targets.length > 0
            ? value.targets
            : [{ channelId: value.channelId, messageId: value.messageId }],
        );
        if (normalizedTargets.length === 0) continue;
        const first = normalizedTargets[0];
        obj[key] = { channelId: first.channelId, messageId: first.messageId };
        if (normalizedTargets.length > 1) {
          obj[key].targets = normalizedTargets;
        }
      }
      const tmp = this.mapFile + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(obj), "utf-8");
      await fs.rename(tmp, this.mapFile);
      this.isMappingDirty = false;
    } catch (e) {
      this.logger.error(`Save mapping failed: ${String(e)}`);
    }
  }

  /**
   * 限制 Map 大小，当超过 MAX_MAP_SIZE 时删除最旧的条目
   * 优化：利用 Map 的自然顺序（插入顺序），直接删除头部元素，避免排序
   */
  private limitMapSize() {
    if (this.sourceToTarget.size <= this.MAX_MAP_SIZE) {
      return;
    }
    
    // Map 保持插入顺序，第一个元素就是最旧的
    // 直接删除头部元素，直到大小符合要求
    let deletedCount = 0;
    while (this.sourceToTarget.size > this.MAX_MAP_SIZE) {
      const firstKey = this.sourceToTarget.keys().next().value;
      if (firstKey) {
        this.sourceToTarget.delete(firstKey);
        deletedCount++;
      } else {
        break;
      }
    }
    
    if (deletedCount > 0) {
      this.logger.debug(`Cleaned ${deletedCount} old mappings to prevent memory overflow`);
    }
  }

  private async processAndSend(message: Message, tag?: string) {
    // 使用无定时器的去重缓存
    if (this.processedIds.has(message.id)) {
      return;
    }
    this.processedIds.add(message.id);

    // 懒加载历史映射（进程首次消息时）
    if (this.sourceToTarget.size === 0) {
      await this.loadMapping();
    }

    // 记录频道活跃时间（主备模式）
    Bot.channelActivity.set(message.channelId, Date.now());

    // 快速检查：路由映射是否存在，不存在则快速返回
    const sendersForThis = this.getSendersForChannel(message.channelId);
    const feishuSendersForThis = this.getFeishuSendersForChannel(message.channelId);
    const dingtalkSendersForThis = this.getDingTalkSendersForChannel(message.channelId);
    const safewSendersForThis = this.getSafewSendersForChannel(message.channelId);

    // 检查是否有 Telegram 映射（受 enableTelegramForward 控制）
    const telegramConfig = (this.config as any).telegramConfig;
    const telegramForwardEnabled = telegramConfig?.enableTelegramForward !== false;
    const telegramMappingsCheck = telegramForwardEnabled ? telegramConfig?.mappings || [] : [];
    const hasTelegramMapping = telegramMappingsCheck.some(
      (m: any) => m.type === 'discord-to-telegram' && m.sourceChannelId === message.channelId
    );
    const hasMobileClientMapping =
      (this.config as any).mobileClientTarget?.enabled === true &&
      ((this.config as any).mappings || []).some((m: any) => String(m?.sourceChannelId || "") === message.channelId);

    // 只有在没有任何转发目标时才返回
    if (
      sendersForThis.length === 0 &&
      feishuSendersForThis.length === 0 &&
      dingtalkSendersForThis.length === 0 &&
      safewSendersForThis.length === 0 &&
      !hasTelegramMapping &&
      !hasMobileClientMapping
    ) {
      return; // 快速返回，不做多余计算
    }

    // 记录消息检测日志（仅在启用机器人中转时，帮助调试）
    if (sendersForThis.length > 0 && sendersForThis.some(s => s.enableBotRelay)) {
      this.logger.info(`[Bot] 检测到消息 (id=${message.id}, channel=${message.channelId}, author=${message.author?.tag || 'unknown'})，准备转发`);
    }

    // 记录消息处理开始，特别是webhook消息
    // 在函数开始处声明一次 isWebhook，后续复用
    // 根据discord.js-selfbot-v13，webhook消息会有webhookId属性
    const isWebhook = !!(message as any).webhookId;
    const webhookId = (message as any).webhookId;
    // webhook消息的name可能在webhook对象中，也可能在author中
    const webhookName = isWebhook 
      ? ((message as any).webhook?.name || (message as any).username || message.author?.username || "unknown")
      : "unknown";
    
    // 详细记录消息信息
    const logPrefix = isWebhook ? `[WEBHOOK]` : `[USER]`;
    const authorInfo = isWebhook
      ? `webhookId=${webhookId} webhookName="${webhookName}"`
      : `authorId=${message.author?.id} authorTag="${message.author?.tag || message.author?.username || "unknown"}"`;
    const authorLabel = isWebhook
      ? (webhookName !== "unknown" ? webhookName : message.author?.username || "Webhook")
      : (message.member as any)?.displayName || message.author?.tag || message.author?.username || "unknown";
    const senderNameHay = buildSenderNameKeywordHaystack(message, isWebhook, webhookName);

    this.logger.info(`${logPrefix} [START] Processing message: channel=${message.channelId} id=${message.id} ${authorInfo}`);
    this.logger.info(`${logPrefix} [CONTENT] content="${(message.content || "").substring(0, 200)}" contentLength=${message.content?.length || 0} embeds=${message.embeds?.length || 0} attachments=${message.attachments?.size || 0}`);

    // 获取规则级别配置（提前获取，用于过滤与OCR检查）
    const ruleConfig = this.getRuleLevelConfig(message.channelId);
    if (ruleConfig.standbyMode?.enabled && ruleConfig.standbyMode.mainChannelId) {
      const mainId = ruleConfig.standbyMode.mainChannelId;
      if (mainId && mainId !== message.channelId) {
        const cooldownMs = Math.max(1, ruleConfig.standbyMode.cooldownSeconds || 60) * 1000;
        const lastMainTime = Bot.channelActivity.get(mainId) || 0;
        const timeDiff = Date.now() - lastMainTime;
        if (lastMainTime > 0 && timeDiff < cooldownMs) {
          const remaining = ((cooldownMs - timeDiff) / 1000).toFixed(1);
          this.logger.info(
            `[STANDBY] 跳过备用频道消息: 主频道(${mainId})在 ${remaining}s 内活跃 (阈值 ${ruleConfig.standbyMode.cooldownSeconds || 60}s)`,
          );
          return;
        }
        if (lastMainTime > 0) {
          this.logger.info(
            `[STANDBY] 触发备用频道转发: 主频道已静默 ${(timeDiff / 1000).toFixed(0)}s`,
          );
        }
      }
    }
    const caseInsensitive = this.config.caseInsensitiveKeywords ?? true;
    const stripEnglish = this.config.stripEnglish === true || ruleConfig.stripEnglish === true;
    const stripChinese = this.config.stripChinese === true || ruleConfig.stripChinese === true;
    const stripOptions = { stripEnglish, stripChinese };
    const effectiveWatermarks = this.config.watermarkEnabled === false
      ? []
      : resolveWatermarkList(
          this.config.watermarks,
          ruleConfig.watermarks,
          this.config.watermark,
          ruleConfig.watermark,
          this.config.watermarkSecondary,
          ruleConfig.watermarkSecondary,
        );
    const effectiveWatermarkRemoval = resolveWatermarkRemovalConfig(
      (this.config as any).watermarkRemoval,
      ruleConfig.watermarkRemoval,
    );
    const effectiveWatermarkCover = resolveWatermarkCoverConfig(
      (this.config as any).watermarkCover,
      ruleConfig.watermarkCover,
    );
    const shouldDetectWatermarkWithOcr = shouldUseOcrWatermarkDetection(effectiveWatermarkRemoval);
    const watermarkRemovalTriggerGroups = parseKeywordGroups(effectiveWatermarkRemoval?.triggerKeywords);
    const shouldUseWatermarkRemovalKeywords = watermarkRemovalTriggerGroups.length > 0;
    const watermarkRemovalTargets = new Set<string>();
    const watermarkRemovalMaskBlocks = new Map<string, any[]>();
    const ocrBlockedImageUrls = new Set<string>();
    const preparedImageAssets = new Map<string, PreparedImageAsset>();
    const markWatermarkRemovalTarget = (targetUrl?: string) => {
      if (!targetUrl) return;
      watermarkRemovalTargets.add(targetUrl);
      const normalized = normalizeImageUrl(targetUrl);
      if (normalized) {
        watermarkRemovalTargets.add(normalized);
      }
    };
    const rememberWatermarkRemovalMaskBlocks = (targetUrl?: string, watermarkBlocks?: any[], allBlocks?: any[]) => {
      if (!targetUrl || !Array.isArray(watermarkBlocks) || watermarkBlocks.length === 0) return;
      const watermarkSet = new Set(watermarkBlocks);
      const protectBlocks = Array.isArray(allBlocks)
        ? allBlocks.filter((block) => block && !watermarkSet.has(block)).map((block) => ({ ...block, maskRole: "protect" }))
        : [];
      const blocks = [
        ...watermarkBlocks.map((block) => ({ ...block, maskRole: "watermark" })),
        ...protectBlocks,
      ];
      watermarkRemovalMaskBlocks.set(targetUrl, blocks);
      const normalized = normalizeImageUrl(targetUrl);
      if (normalized) {
        watermarkRemovalMaskBlocks.set(normalized, blocks);
      }
    };
    const getWatermarkRemovalMaskBlocks = (targetUrl?: string) => {
      if (!targetUrl) return undefined;
      return watermarkRemovalMaskBlocks.get(targetUrl) || watermarkRemovalMaskBlocks.get(normalizeImageUrl(targetUrl));
    };
    const rememberPreparedImageAsset = (asset: PreparedImageAsset) => {
      preparedImageAssets.set(asset.originalUrl, asset);
      const normalized = normalizeImageUrl(asset.originalUrl);
      if (normalized) {
        preparedImageAssets.set(normalized, asset);
      }
    };
    const getPreparedImageAsset = (targetUrl?: string) => {
      if (!targetUrl) return undefined;
      return preparedImageAssets.get(targetUrl) || preparedImageAssets.get(normalizeImageUrl(targetUrl));
    };

    // 忽略选项检查（规则级别优先，未设置则使用全局设置）
    try {
      // 忽略自己的消息
      const shouldIgnoreSelf = ruleConfig.ignoreSelf !== undefined
        ? ruleConfig.ignoreSelf
        : this.config.ignoreSelf;
      if (shouldIgnoreSelf && message.author?.id === (this.client as any).user?.id) {
        this.logger.info(`${logPrefix} [SKIP] Ignoring own message (ignoreSelf=true, rule=${ruleConfig.ignoreSelf})`);
        return;
      }

      // 忽略机器人消息
      const shouldIgnoreBot = ruleConfig.ignoreBot !== undefined
        ? ruleConfig.ignoreBot
        : this.config.ignoreBot;
      if (shouldIgnoreBot && (message.author?.bot || isWebhook)) {
        this.logger.info(`${logPrefix} [SKIP] Ignoring bot/webhook message (ignoreBot=true, rule=${ruleConfig.ignoreBot})`);
        return;
      }

      const shouldOnlyBot = ruleConfig.onlyBot === true || (this.config as any).onlyBot === true;
      if (shouldOnlyBot && !(message.author?.bot || isWebhook)) {
        this.logger.info(`${logPrefix} [SKIP] Only forwarding bot/webhook message (onlyBot=true, rule=${ruleConfig.onlyBot})`);
        return;
      }

      // 检查附件类型并忽略（全局 + 规则级别）
      // 规则级别设置优先，如果规则级别未设置则使用全局设置
      const shouldIgnoreImages = ruleConfig.ignoreImages !== undefined
        ? ruleConfig.ignoreImages
        : this.config.ignoreImages;
      const shouldIgnoreAudio = ruleConfig.ignoreAudio !== undefined
        ? ruleConfig.ignoreAudio
        : this.config.ignoreAudio;
      const shouldIgnoreVideo = ruleConfig.ignoreVideo !== undefined
        ? ruleConfig.ignoreVideo
        : this.config.ignoreVideo;
      const shouldIgnoreDocuments = ruleConfig.ignoreDocuments !== undefined
        ? ruleConfig.ignoreDocuments
        : this.config.ignoreDocuments;

      if (shouldIgnoreImages) {
        const hasImage = hasImageAttachment(message.attachments) || hasForwardedImage(message);
        const hasTextContent = collectMessageTextPieces(message)
          .some((piece) => String(piece || "").trim().length > 0);
        if (shouldSkipMessageForIgnoredImages({ shouldIgnoreImages, hasImage, hasTextContent })) {
          this.logger.info(`${logPrefix} [SKIP] Ignoring image-only message (ignoreImages=true, rule=${ruleConfig.ignoreImages})`);
          return;
        }
        if (hasImage) {
          this.logger.info(`${logPrefix} [FILTER] Ignoring image attachments but preserving text content`);
        }
      }

      if (message.attachments && message.attachments.size > 0) {
        for (const att of message.attachments.values()) {
          const ct = (att.contentType || "").toLowerCase();
          const url = (att.url || "").toLowerCase();

          // 忽略音频
          if (shouldIgnoreAudio && (ct.startsWith("audio/") || AUDIO_EXT_RE.test(url))) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring audio attachment (ignoreAudio=true, rule=${ruleConfig.ignoreAudio})`);
            return;
          }

          // 忽略视频
          if (shouldIgnoreVideo && (ct.startsWith("video/") || VIDEO_EXT_RE.test(url))) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring video attachment (ignoreVideo=true)`);
            return;
          }

          // 忽略文档
          if (shouldIgnoreDocuments && (
            ct.includes("application/pdf") ||
            ct.includes("application/msword") ||
            ct.includes("application/vnd.openxmlformats") ||
            DOCUMENT_EXT_RE.test(url)
          )) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring document attachment (ignoreDocuments=true)`);
            return;
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] Ignore filter check failed: ${String(e?.message || e)}`);
    }

    // 连续重复去重：上一条和当前一致则跳过
    if (this.config.dedupeSequentialMessages === true) {
      const signature = this.buildSequentialSignature(message);
      const last = this.sequentialDedupe.get(message.channelId);
      if (last && last === signature) {
        this.logger.info(`${logPrefix} [SKIP] Duplicate sequential message (channel=${message.channelId})`);
        return;
      }
      this.sequentialDedupe.set(message.channelId, signature);
    }

    // OCR 图片检测过滤（全局 + 规则级别）
    try {
      const globalOcrBlocked = parseKeywordGroups(this.config.ocrBlockedKeywords);
      const ruleOcrBlocked = parseKeywordGroups(ruleConfig.ocrBlockedKeywords);
      const allOcrBlocked = [...globalOcrBlocked, ...ruleOcrBlocked];
      const globalOcrTrigger = parseKeywordGroups(this.config.ocrTriggerKeywords);
      const ruleOcrTrigger = parseKeywordGroups(ruleConfig.ocrTriggerKeywords);
      const activeOcrTrigger = globalOcrTrigger.length > 0 ? globalOcrTrigger : ruleOcrTrigger;
      const needsOcrFilterCheck = allOcrBlocked.length > 0 || activeOcrTrigger.length > 0;
      const needsOcrCheck = needsOcrFilterCheck || shouldDetectWatermarkWithOcr;

      if (needsOcrCheck) {
        const imageAttachments: ImageAsset[] = [];
        const seenImageUrls = new Set<string>();
        const addImageAttachment = (asset: ImageAsset) => {
          if (!asset.url) return;
          const normalized = normalizeImageUrl(asset.url);
          if (seenImageUrls.has(asset.url) || (normalized && seenImageUrls.has(normalized))) {
            return;
          }
          seenImageUrls.add(asset.url);
          if (normalized) {
            seenImageUrls.add(normalized);
          }
          imageAttachments.push(asset);
        };

        for (const asset of collectImageAssets(message)) {
          addImageAttachment(asset);
        }

        const includeCurrentEmbedImages = Boolean(effectiveWatermarkRemoval) || shouldDetectWatermarkWithOcr;
        if (includeCurrentEmbedImages) {
          for (const embedUrl of collectEmbedImageUrls(message.embeds || [])) {
            addImageAttachment({ url: embedUrl });
          }
        }

        if (imageAttachments.length > 0) {
          if (!this.ocrClient) {
            if (needsOcrFilterCheck) {
              const msg = `${logPrefix} [OCR] OCR客户端未初始化，无法检测图片，跳过转发`;
              console.log(`[OCR] ${msg}`);
              this.logger.info(msg);
              return;
            }
            const msg = `${logPrefix} [OCR] OCR客户端未初始化，跳过水印检测，保留原图`;
            console.log(`[OCR] ${msg}`);
            this.logger.info(msg);
          } else {
            console.log(`[OCR] 消息包含 ${imageAttachments.length} 张图片，开始检测...`);
            this.logger.info(`${logPrefix} [OCR] 开始检测图片中的文字...`);

            let watermarkDetectionCheckedImages = 0;
            let checkedImages = 0;
            let blockedImages = 0;
            let triggerMatched = activeOcrTrigger.length === 0;

            if (shouldDetectWatermarkWithOcr) {
              for (const attachment of imageAttachments) {
                const url = attachment.url;
                const contentType = attachment.contentType || "";
                console.log(`[OCR] 预检测图片 ${attachment.name || attachment.url} (类型: ${contentType || "unknown"})`);

                try {
                  console.log(`[OCR] 开始OCR识别原图（用于决定是否去水印）...`);
                  const ocrResult = await this.ocrClient.recognizeImage(url);
                  const ocrText = OCRClient.extractText(ocrResult);
                  watermarkDetectionCheckedImages++;

                  if (shouldUseWatermarkRemovalKeywords) {
                    const keywordMatch = matchWatermarkRemovalTriggerKeywords(
                      ocrText,
                      watermarkRemovalTriggerGroups,
                      caseInsensitive,
                    );
                    if (keywordMatch.matched) {
                      markWatermarkRemovalTarget(url);
                      const matchedBlocks = Array.isArray((ocrResult as any)?.data)
                        ? (ocrResult as any).data.filter((block: any) =>
                            matchWatermarkRemovalTriggerKeywords(
                              String(block?.text || ""),
                              watermarkRemovalTriggerGroups,
                              caseInsensitive,
                            ).matched,
                          )
                        : [];
                      rememberWatermarkRemovalMaskBlocks(
                        url,
                        matchedBlocks,
                        Array.isArray((ocrResult as any)?.data) ? (ocrResult as any).data : [],
                      );
                      const detectMsg = `${logPrefix} [WATERMARK] OCR命中去水印关键词: ${keywordMatch.matchedKeywords.join("、")}`;
                      console.log(`[OCR] ${detectMsg}`);
                      this.logger.info(detectMsg);
                    }
                  } else {
                    const detection = detectTextWatermarkFromOCR(ocrResult);
                    if (detection.matched) {
                      markWatermarkRemovalTarget(url);
                      rememberWatermarkRemovalMaskBlocks(
                        url,
                        detection.blocks,
                        Array.isArray((ocrResult as any)?.data) ? (ocrResult as any).data : [],
                      );
                      const detectMsg = `${logPrefix} [WATERMARK] OCR检测到疑似水印: ${detection.texts.join("、")} (${detection.reason || "heuristic"})`;
                      console.log(`[OCR] ${detectMsg}`);
                      this.logger.info(detectMsg);
                    }
                  }
                } catch (ocrError: any) {
                  const errorMsg = `${logPrefix} [OCR] 原图预检测失败: ${ocrError.message}，继续处理其他附件`;
                  console.error(`[OCR] ${errorMsg}`);
                  console.error(`[OCR] 错误详情:`, ocrError);
                  console.error(`[OCR] 错误堆栈: ${ocrError.stack}`);
                  this.logger.error(errorMsg);
                }
              }
            }

            if (needsOcrFilterCheck) {
              for (const attachment of imageAttachments) {
                const normalizedUrl = normalizeImageUrl(attachment.url);
                const shouldRemoveWatermark = Boolean(
                  effectiveWatermarkRemoval &&
                    (
                      effectiveWatermarkRemoval.mode === "always" ||
                      watermarkRemovalTargets.has(attachment.url) ||
                      (normalizedUrl && watermarkRemovalTargets.has(normalizedUrl))
                    ),
                );
                const prepared = await prepareImageForOcrAndForward(attachment.url, {
                  shouldRemoveWatermark,
                  config: effectiveWatermarkRemoval,
                  maskBlocks: getWatermarkRemovalMaskBlocks(attachment.url),
                });
                const preparedAsset: PreparedImageAsset = {
                  ...attachment,
                  ...prepared,
                  watermarkRemovalState: prepared.removalAttempted
                    ? {
                        attempted: prepared.removalAttempted,
                        failed: prepared.removalFailed,
                      }
                    : undefined,
                };
                rememberPreparedImageAsset(preparedAsset);

                if (prepared.removalAttempted) {
                  if (prepared.removalFailed) {
                    const failureMsg = `${logPrefix} [WATERMARK] 去水印失败，回退原图后执行OCR屏蔽检测`;
                    console.warn(`[OCR] ${failureMsg}`);
                    this.logger.warn(failureMsg);
                  } else if (prepared.forwardUrl !== attachment.url) {
                    const successMsg = `${logPrefix} [WATERMARK] 已先去水印，再执行OCR屏蔽检测`;
                    console.log(`[OCR] ${successMsg}`);
                    this.logger.info(successMsg);
                  }
                }

                const ocrUrl = prepared.ocrUrl;
                const contentType = attachment.contentType || "";
                console.log(`[OCR] 检测到图片 ${attachment.name || attachment.url} (类型: ${contentType || "unknown"})`);

                try {
                  console.log(`[OCR] 开始OCR识别...`);
                  const ocrResult = await this.ocrClient.recognizeImage(ocrUrl);
                  const ocrText = OCRClient.extractText(ocrResult);
                  checkedImages++;

                  if (allOcrBlocked.length > 0) {
                    const { matchedGroups, matchedKeywords } = matchParsedKeywordGroups(ocrText, allOcrBlocked, {
                      caseInsensitive,
                    });
                    if (matchedGroups.length > 0) {
                      markBlockedImageUrl(ocrBlockedImageUrls, attachment.url);
                      markBlockedImageUrl(ocrBlockedImageUrls, ocrUrl);
                      blockedImages++;
                      const errorMsg =
                        `${logPrefix} [OCR] 检测到屏蔽文字 "${matchedKeywords.join('", "')}"，屏蔽该图片并继续转发文字`;
                      console.log(`[OCR] ${errorMsg}`);
                      this.logger.info(errorMsg);
                      continue;
                    }
                  }

                  if (!triggerMatched && activeOcrTrigger.length > 0) {
                    const { matchedGroups } = matchParsedKeywordGroups(ocrText, activeOcrTrigger, {
                      caseInsensitive,
                    });
                    if (matchedGroups.length > 0) {
                      triggerMatched = true;
                      const hitMsg = `${logPrefix} [OCR] 触发关键词命中: ${formatKeywordGroups(matchedGroups)}`;
                      console.log(`[OCR] ${hitMsg}`);
                      this.logger.info(hitMsg);
                    }
                  }
                } catch (ocrError: any) {
                  const errorMsg = `${logPrefix} [OCR] 识别失败: ${ocrError.message}，继续处理其他附件`;
                  console.error(`[OCR] ${errorMsg}`);
                  console.error(`[OCR] 错误详情:`, ocrError);
                  console.error(`[OCR] 错误堆栈: ${ocrError.stack}`);
                  this.logger.error(errorMsg);
                }
              }

              if (activeOcrTrigger.length > 0 && !triggerMatched) {
                const msg = `${logPrefix} [OCR] 未命中触发关键词，跳过转发`;
                console.log(`[OCR] ${msg}`);
                this.logger.info(msg);
                return;
              }

              const finalMsg =
                `${logPrefix} [OCR] 图片检测完成，总图片数=${imageAttachments.length}，预检测=${watermarkDetectionCheckedImages}，过滤检测=${checkedImages}，屏蔽图片=${blockedImages}，允许转发`;
              console.log(`[OCR] ${finalMsg}`);
              this.logger.info(finalMsg);
            } else if (shouldDetectWatermarkWithOcr) {
              const finalMsg =
                `${logPrefix} [OCR] 去水印预检测完成，总图片数=${imageAttachments.length}，已检测=${watermarkDetectionCheckedImages}`;
              console.log(`[OCR] ${finalMsg}`);
              this.logger.info(finalMsg);
            }
          }
        }
      }
    } catch (e: any) {
      const errorMsg = `${logPrefix} [ERROR] OCR filter check failed: ${String(e?.message || e)}`;
      console.error(`[OCR] ${errorMsg}`);
      console.error(`[OCR] 错误堆栈: ${e?.stack || "N/A"}`);
      this.logger.error(errorMsg);
    }

    // 特别记录webhook消息的embeds信息（webhook消息通常只有embeds没有content）
    if (isWebhook && message.embeds && message.embeds.length > 0) {
      this.logger.info(`${logPrefix} [WEBHOOK-EMBEDS] Webhook消息包含 ${message.embeds.length} 个embeds，将传递给发送器`);
    }
    
    // 记录embed详细信息
    if (message.embeds && message.embeds.length > 0) {
      for (let i = 0; i < message.embeds.length; i++) {
        const embed = message.embeds[i];
        this.logger.info(`${logPrefix} [EMBED-${i}] title="${embed.title || ""}" description="${(embed.description || "").substring(0, 200)}" fields=${embed.fields?.length || 0}`);
      }
    }

    const renderOutput = await this.messageAction(message, tag);

    const rawContent = (message.content || "").trim();
    const hasText = rawContent !== "";
    let originalContent = (renderOutput.content || "").trim();
    let useEmbed = true; // 默认使用嵌入形式展示消息

    // 若整条仅为 :alias: 表情（允许多个），在顶层直接跳过翻译与嵌入
    try {
      const rawContentCleanedTop = (rawContent || "").replace(/\p{Cf}/gu, "");
      const aliasFilterRawTop = rawContentCleanedTop.replace(/[^:\sA-Za-z0-9_~+\.-]/gu, "");
      const isOnlyAliasEmotesTop = /^(?:\s*:[A-Za-z0-9_~+\.-]+:\s*)+$/u.test(aliasFilterRawTop);
      // 严格模式：若整条消息首字符为 ':' 且末字符为 ':'，也视为表情别名消息
      const strictAlias = (() => {
        const t = rawContent.replace(/\p{Cf}/gu, "").trim();
        return t.startsWith(":") && t.endsWith(":") && !/[\n\r]/.test(t);
      })();
      if (isOnlyAliasEmotesTop || strictAlias) {
        originalContent = rawContent; // 保持原样
        useEmbed = false;
      }
    } catch {}

    // end of special handling removed

    // Twitter/X 单链接：以纯文本发送，触发 Discord 原生预览
    if (this.RE_TWITTER.test(rawContent)) {
        originalContent = rawContent.replace(/[<>]/g, "");
        useEmbed = false;
      }

    // GIF 链接的处理移动到附件收集之后

    // 路由：仅当该源频道在映射中时才转发；未映射则跳过（sendersForThis 已在前面检查过）
    if (sendersForThis.length > 0) {
      this.logger.info(`${logPrefix} [ROUTE] Found ${sendersForThis.length} mapping(s) for channel ${message.channelId}, will forward to webhook(s)`);
    } else if (feishuSendersForThis.length > 0) {
      this.logger.info(`${logPrefix} [ROUTE] Found ${feishuSendersForThis.length} Feishu mapping(s) for channel ${message.channelId}`);
    } else if (dingtalkSendersForThis.length > 0) {
      this.logger.info(`${logPrefix} [ROUTE] Found ${dingtalkSendersForThis.length} DingTalk mapping(s) for channel ${message.channelId}`);
    } else if (safewSendersForThis.length > 0) {
      this.logger.info(`${logPrefix} [ROUTE] Found ${safewSendersForThis.length} SafeW mapping(s) for channel ${message.channelId}`);
    }

    // 用户过滤：全局白名单/黑名单 + 规则级别白名单/黑名单
    // 优先级：全局设置 > 规则级别设置
    // 注意：webhook 消息的 author 可能为 null，需要特殊处理
    try {
      const authorId = message.author?.id;

      // 如果是 webhook 消息，跳过用户ID过滤（因为 webhook 没有用户ID）
      if (!isWebhook && authorId) {
        // 全局设置
        const globalAllowed = (this.config.allowedUsersIds || []).map((x: any) => String(x)).filter(Boolean);
        const globalMuted = (this.config.mutedUsersIds || []).map((x: any) => String(x)).filter(Boolean);
        const globalAllowedRoles = (this.config.allowedRoleIds || []).map((x: any) => String(x)).filter(Boolean);
        const globalMutedRoles = (this.config.mutedRoleIds || []).map((x: any) => String(x)).filter(Boolean);

        // 规则级别设置
        const ruleAllowed = ruleConfig.allowedUsersIds;
        const ruleMuted = ruleConfig.mutedUsersIds;

        // 全局黑名单优先级最高：如果在全局黑名单中，直接跳过
        if (globalMuted.length > 0 && globalMuted.includes(authorId)) {
          this.logger.info(`${logPrefix} [SKIP] Author ${authorId} in global mutedUsersIds`);
          return;
        }

        // 全局白名单次之：如果全局白名单非空，必须在其中
        if (globalAllowed.length > 0 && !globalAllowed.includes(authorId)) {
          this.logger.info(`${logPrefix} [SKIP] Author ${authorId} not in global allowedUsersIds`);
          return;
        }

        // 身份组过滤（全局）：黑名单优先
        if (globalAllowedRoles.length > 0 || globalMutedRoles.length > 0) {
          const memberRoleIds = message.member?.roles?.cache
            ? Array.from(message.member.roles.cache.keys())
            : [];
          if (globalMutedRoles.length > 0 && memberRoleIds.some((id) => globalMutedRoles.includes(id))) {
            this.logger.info(`${logPrefix} [SKIP] Member in global mutedRoleIds`);
            return;
          }
          if (globalAllowedRoles.length > 0 && !memberRoleIds.some((id) => globalAllowedRoles.includes(id))) {
            this.logger.info(`${logPrefix} [SKIP] Member not in global allowedRoleIds`);
            return;
          }
        }

        // 规则级别黑名单：如果在规则黑名单中，跳过
        if (ruleMuted.length > 0 && ruleMuted.includes(authorId)) {
          this.logger.info(`${logPrefix} [SKIP] Author ${authorId} in rule mutedUsersIds`);
          return;
        }

        // 规则级别白名单：如果规则白名单非空，必须在其中
        if (ruleAllowed.length > 0 && !ruleAllowed.includes(authorId)) {
          this.logger.info(`${logPrefix} [SKIP] Author ${authorId} not in rule allowedUsersIds`);
          return;
        }

        this.logger.info(`${logPrefix} [FILTER] User ID filter passed`);
      } else if (isWebhook) {
        this.logger.info(`${logPrefix} [FILTER] Webhook message, skipping user ID filter`);
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] User filter check failed: ${String(e?.message || e)}`);
    }

    try {
      const blockedSenderNameGroups = parseKeywordGroups(ruleConfig.blockedSenderNameKeywords);
      if (blockedSenderNameGroups.length > 0) {
        const { matchedGroups } = matchParsedKeywordGroups(senderNameHay, blockedSenderNameGroups, { caseInsensitive });
        if (matchedGroups.length > 0) {
          this.logger.info(`${logPrefix} [SKIP] Sender name blocked keyword matched: ${formatKeywordGroups(matchedGroups)}`);
          return;
        }
      }

      const allowedSenderNameGroups = parseKeywordGroups(ruleConfig.allowedSenderNameKeywords);
      if (allowedSenderNameGroups.length > 0) {
        const { matchedGroups } = matchParsedKeywordGroups(senderNameHay, allowedSenderNameGroups, { caseInsensitive });
        if (matchedGroups.length === 0) {
          this.logger.info(`${logPrefix} [SKIP] Sender name did not match allowedSenderNameKeywords`);
          return;
        }
        this.logger.info(`${logPrefix} [FILTER] Sender name allowed keyword matched: ${formatKeywordGroups(matchedGroups)}`);
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] Sender name keyword filter failed: ${String(e?.message || e)}`);
    }

    const textHay = collectMessageTextPieces(message).join("\n");
    const hasTextForKeywords = textHay.trim().length > 0;

    // language filter: 仅对文本生效（全局 + 规则级别）
    if (hasTextForKeywords) {
      try {
        const ratio = getLanguageRatio(textHay);
        if (ratio.total > 0) {
          const englishThreshold = clampPercent(this.config.ignoreEnglishThreshold, 100);
          const chineseThreshold = clampPercent(this.config.ignoreChineseThreshold, 100);
          const ruleEnglishThreshold = clampPercent(ruleConfig.ignoreEnglishThreshold, 100);
          const ruleChineseThreshold = clampPercent(ruleConfig.ignoreChineseThreshold, 100);
          const englishRatio = Math.round(ratio.englishRatio);
          const chineseRatio = Math.round(ratio.chineseRatio);

          if (this.config.ignoreEnglish && englishRatio >= englishThreshold) {
            this.logger.info(`${logPrefix} [SKIP] 忽略英文(占比${englishRatio}%>=${englishThreshold}%)`);
            return;
          }
          if (this.config.ignoreChinese && chineseRatio >= chineseThreshold) {
            this.logger.info(`${logPrefix} [SKIP] 忽略中文(占比${chineseRatio}%>=${chineseThreshold}%)`);
            return;
          }
          if (ruleConfig.ignoreEnglish && englishRatio >= ruleEnglishThreshold) {
            this.logger.info(`${logPrefix} [SKIP] 规则忽略英文(占比${englishRatio}%>=${ruleEnglishThreshold}%)`);
            return;
          }
          if (ruleConfig.ignoreChinese && chineseRatio >= ruleChineseThreshold) {
            this.logger.info(`${logPrefix} [SKIP] 规则忽略中文(占比${chineseRatio}%>=${ruleChineseThreshold}%)`);
            return;
          }
        }
      } catch (e: any) {
        this.logger.error(`${logPrefix} [ERROR] 语言占比过滤失败: ${String(e?.message || e)}`);
      }
    }

    // keyword filter: 全局 + 规则级别关键词触发
    // 优先级：全局设置 > 规则级别设置
    try {
      const globalGroups = parseKeywordGroups(this.config.blockedKeywords);
      const ruleGroups = parseKeywordGroups(ruleConfig.blockedKeywords);
      const hay = textHay;

      // 全局关键词触发优先
      if (globalGroups.length > 0 && hasTextForKeywords) {
        const { matchedGroups } = matchParsedKeywordGroups(hay, globalGroups, { caseInsensitive });
        if (matchedGroups.length === 0) {
          this.logger.info(`${logPrefix} [SKIP] No global keyword matched`);
          return;
        }
        this.logger.info(`${logPrefix} [FILTER] Global keyword matched: ${formatKeywordGroups(matchedGroups)}`);
      } else if (ruleGroups.length > 0 && hasTextForKeywords) {
        // 规则级别关键词触发
        const { matchedGroups } = matchParsedKeywordGroups(hay, ruleGroups, { caseInsensitive });
        if (matchedGroups.length === 0) {
          this.logger.info(`${logPrefix} [SKIP] No rule keyword matched`);
          return;
        }
        this.logger.info(`${logPrefix} [FILTER] Rule keyword matched: ${formatKeywordGroups(matchedGroups)}`);
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] Keyword filter failed: ${String(e?.message || e)}`);
    }

    // exclude keywords: 全局 + 规则级别屏蔽关键词
    try {
      const globalExcludes = parseKeywordGroups(this.config.excludeKeywords);
      const ruleExcludes = parseKeywordGroups(ruleConfig.excludeKeywords);
      const hay = textHay;

      // 全局屏蔽关键词优先
      if (globalExcludes.length > 0 && hasTextForKeywords) {
        const { matchedGroups } = matchParsedKeywordGroups(hay, globalExcludes, { caseInsensitive });
        if (matchedGroups.length > 0) {
          this.logger.info(`${logPrefix} [SKIP] Global exclude keyword matched: ${formatKeywordGroups(matchedGroups)}`);
          return;
        }
      }
      // 规则级别屏蔽关键词
      if (ruleExcludes.length > 0 && hasTextForKeywords) {
        const { matchedGroups } = matchParsedKeywordGroups(hay, ruleExcludes, { caseInsensitive });
        if (matchedGroups.length > 0) {
          this.logger.info(`${logPrefix} [SKIP] Rule exclude keyword matched: ${formatKeywordGroups(matchedGroups)}`);
          return;
        }
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] Exclude keyword filter failed: ${String(e?.message || e)}`);
    }
    const showSourceIdentity =
      ruleConfig.showSourceIdentity === true ? true : this.config.showSourceIdentity === true;
    let replyToTarget: { channelId: string; messageId: string } | undefined;
    // 给样式2使用的回复元信息（仅用于格式化文本）
    let replyUserNameForStyle2: string | undefined;
    let replyContentForStyle2: string | undefined;
    let ctaLine: string | undefined;
    if (message.reference) {
      try {
        if (typeof (message as any).fetchReference !== "function") {
          throw new Error("fetchReference unavailable");
        }
        const ref = await (message as any).fetchReference();
        const mappedEntry = this.sourceToTarget.get(ref.id);
        let mapped = mappedEntry ? { channelId: mappedEntry.channelId, messageId: mappedEntry.messageId } : undefined;
        // 不重发，改为：若无映射，尝试在目标历史中扫描已有消息并建立映射
        if (!mapped) {
          try {
            // 使用第一个 sender 来扫描目标频道
            const firstSender = sendersForThis.length > 0 ? sendersForThis[0] : undefined;
            const found = await this.tryResolveMappingFromTarget(ref.id, firstSender);
            if (found) {
              mapped = found;
            }
          } catch (e) {
            console.error("scan target for mapping failed", e);
            this.logger.error(`scan target for mapping failed: ${String(e)}`);
          }
        }
        if (mapped) {
          replyToTarget = { channelId: mapped.channelId, messageId: mapped.messageId };
          // 无论是否有附件/Embed，都生成 CTA 行；有资产时用"查看附件"，否则用"查看消息"
          // 使用第一个 sender 来获取 webhookGuildId
          const firstSender = sendersForThis.length > 0 ? sendersForThis[0] : undefined;
          if (firstSender?.webhookGuildId) {
            const link = `https://discord.com/channels/${firstSender.webhookGuildId}/${mapped.channelId}/${mapped.messageId}`;
            let display: string;
            if (showSourceIdentity) {
              // 显示源用户名称
              display = (ref.member as any)?.displayName || ref.author?.username || ref.author?.tag || "用户";
            } else {
              // 使用 webhook 名称
              display = (firstSender as any).webhookName || "Webhook";
            }
          const hasAssets = (ref.attachments?.size ?? 0) > 0 || (ref.embeds?.length ?? 0) > 0;
          const stripAllText = stripEnglish === true && stripChinese === true;
          const preferEnglishLabel = stripChinese === true && stripEnglish !== true;
          const preferChineseLabel = stripEnglish === true && stripChinese !== true;
          let label: string;
          if (stripAllText) {
            label = "🔗";
          } else if (preferEnglishLabel) {
            label = hasAssets ? "View attachment" : "View message";
          } else if (preferChineseLabel) {
            label = hasAssets ? "查看附件" : "查看消息";
          } else {
            label = hasAssets ? "查看附件" : "查看消息";
          }
          ctaLine = `↳ @${display}: [${label}](${link})`;
          }
          // 记录被回复用户名称和内容（用于样式2显示）
          replyUserNameForStyle2 = (ref.member as any)?.displayName || ref.author?.username || ref.author?.tag || "用户";
          replyContentForStyle2 = ref.content || (ref.attachments?.size > 0 ? "[附件]" : ref.embeds?.length > 0 ? "[嵌入信息]" : "");
        }
      } catch (err) {
        const msg = String(err);
        if (msg.includes("fetchReference unavailable")) {
          // 外部消息源无法获取引用消息时，跳过回复映射
        } else {
          console.error(err);
          this.logger.error(`fetchReference failed: ${msg}`);
        }
      }
    }

    // 根据配置对 Discord->Discord 文本应用样式
    const rawStyle = (this.config as any).feishuStyle;
    const forwardStyle = rawStyle === "style2" || rawStyle === "style3" ? rawStyle : "style1";
    const isReplyMessage = !!message.reference;
    
    // 样式1：保持原有逻辑（包含CTA）
    // 样式2：普通消息直接发originalContent（不含CTA），回复消息时上面发originalContent，下面发embed
    let discordContent: string;
    let style2ReplyEmbed: any | undefined = undefined;
    
    // 飞书转发始终使用包含CTA的完整内容（不受样式影响）
    const feishuParts: string[] = [];
    if (ctaLine) feishuParts.push(ctaLine);
    if (originalContent) feishuParts.push(originalContent);
    const finalContent = feishuParts.join("\n");
    
    if (forwardStyle === "style1") {
      // 样式1：拼装最终内容，CTA 在顶部
      discordContent = finalContent;
    } else {
      // 样式2/3：普通消息直接发 originalContent（不含 CTA）
      discordContent = originalContent || "";
      if (forwardStyle === "style2") {
        useEmbed = false; // 样式2下，主内容不使用 embed
        // 但是，如果消息只有 embeds（比如 webhook 消息），即使在 style2 模式下也需要使用 embed
        if (!hasText && message.embeds && message.embeds.length > 0) {
          useEmbed = true;
        }
      } else {
        // 样式3：主内容使用 embed
        useEmbed = true;
      }
      
      if (isReplyMessage && replyUserNameForStyle2) {
        // 回复消息：生成一个蓝色嵌入块，包含粗体"💬 回复 用户名"、被回复内容和底部小时间
        const now = new Date(message.createdTimestamp || Date.now());
        const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
        const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
          now.getHours(),
        )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        
        const replyTitle = `💬 回复 ${replyUserNameForStyle2}`;
        const replyBody =
          replyContentForStyle2 || (forwardStyle === "style3" ? "回复消息" : "");
        style2ReplyEmbed = {
          color: 0x0000FF, // 蓝色
          description:
            forwardStyle === "style3"
              ? replyBody
              : `**${replyTitle}**\n${replyBody}`,
          footer: {
            text: `⏰ ${ts}`
          }
        };
        if (forwardStyle === "style3") {
          // 确保样式3不显示嵌入标题头
          style2ReplyEmbed.title = undefined;
          style2ReplyEmbed.author = undefined;
          if (typeof style2ReplyEmbed.description === "string") {
            const cleaned = style2ReplyEmbed.description
              .replace(/^(\*\*)?💬 回复[^\n]*\n?/, "")
              .trim();
            style2ReplyEmbed.description = cleaned || "回复消息";
          }
        }
      }
    }

    const longMessageConfig = ruleConfig.longMessage;
    if (longMessageConfig?.enabled) {
      discordContent = applyLongMessageConfig(discordContent, longMessageConfig);
    }
    const feishuContentRaw = applyLongMessageConfig(finalContent, longMessageConfig);
    const messageComponents = Array.isArray((message as any).components) ? (message as any).components : [];
    const componentLinks = extractDiscordComponentLinks(messageComponents);
    if (componentLinks.length > 0) {
      const labels = componentLinks.map((link) => link.label).join(", ");
      this.logger.info(`${logPrefix} [COMPONENTS] Found ${componentLinks.length} link button(s): ${labels}`);
    } else if (messageComponents.length > 0) {
      this.logger.info(`${logPrefix} [COMPONENTS] Found ${messageComponents.length} component(s), no link buttons parsed`);
    }
    discordContent = appendDiscordComponentLinks(discordContent, messageComponents);
    const feishuContentWithLinks = appendDiscordComponentLinks(feishuContentRaw, messageComponents, { format: "markdown" });

    // 根据配置决定是否伪装为源用户头像和昵称
    // 对于 webhook 消息，使用 webhook 的名称和头像
    let username: string | undefined = undefined;
    let avatarUrl: string | undefined = undefined;
    
    if (showSourceIdentity) {
      try {
        if (isWebhook) {
          // Webhook 消息：使用之前获取的webhookName（避免重复获取）
          username = webhookName !== "unknown" ? webhookName : "Webhook";
          const anyAuthor = message.author as any;
          if (typeof anyAuthor?.displayAvatarURL === "function") {
            avatarUrl = anyAuthor.displayAvatarURL({ size: 128, dynamic: true });
          } else if (typeof anyAuthor?.avatarURL === "function") {
            avatarUrl = anyAuthor.avatarURL({ size: 128, dynamic: true });
          }

          if (!avatarUrl) {
            const webhook = (message as any).webhook;
            if (typeof webhook?.avatarURL === "function") {
              avatarUrl = webhook.avatarURL({ size: 128, dynamic: true });
            } else if (typeof webhook?.avatar === "string") {
              if (/^https?:\/\//i.test(webhook.avatar)) {
                avatarUrl = webhook.avatar;
              } else if (webhookId) {
                const ext = webhook.avatar.startsWith("a_") ? "gif" : "png";
                avatarUrl = `https://cdn.discordapp.com/avatars/${webhookId}/${webhook.avatar}.${ext}?size=128`;
              }
            }
          }
        } else {
          // 普通用户消息
          username = (message.member as any)?.displayName || message.author?.username || message.author?.tag;
          const anyAuthor = message.author as any;
          if (typeof anyAuthor?.displayAvatarURL === "function") {
            avatarUrl = anyAuthor.displayAvatarURL({ size: 128, format: "png" });
          } else if (typeof anyAuthor?.avatarURL === "function") {
            avatarUrl = anyAuthor.avatarURL({ size: 128, format: "png" });
          }
        }
      } catch (e: any) {
        this.logger.error(`${logPrefix} [ERROR] Failed to get username/avatar: ${String(e?.message || e)}`);
      }
    }

    // 收集需要上传的附件：首张图片将内嵌到同一个 Embed，视频/其他作为同条消息的附件（可直接播放）
    // 根据忽略设置过滤附件
    const uploads: Array<{
      url: string;
      filename: string;
      sourceUrl?: string;
      isImage?: boolean;
      isVideo?: boolean;
      watermarkRemoval?: WatermarkRemovalConfig;
      watermarkRemovalState?: WatermarkRemovalRuntimeState;
      watermarkCover?: WatermarkCoverConfig;
    }> = [];
    let hasCurrentImage = false;
    let imageIndex = 0;
    try {
      // 获取忽略设置（全局 + 规则级别）
      const uploadRuleConfig = this.getRuleLevelConfig(message.channelId);
      const skipImages = uploadRuleConfig.ignoreImages !== undefined
        ? uploadRuleConfig.ignoreImages
        : this.config.ignoreImages;
      const skipAudio = uploadRuleConfig.ignoreAudio !== undefined
        ? uploadRuleConfig.ignoreAudio
        : this.config.ignoreAudio;
      const skipVideo = this.config.ignoreVideo;
      const skipDocuments = this.config.ignoreDocuments;
      const decorateUpload = (item: {
        url: string;
        filename: string;
        isImage?: boolean;
        isVideo?: boolean;
      }) => {
        let decorated: typeof item & {
          sourceUrl?: string;
          watermarkRemoval?: WatermarkRemovalConfig;
          watermarkRemovalState?: WatermarkRemovalRuntimeState;
          watermarkCover?: WatermarkCoverConfig;
        } = item;
        if (
          effectiveWatermarkCover &&
          ((item.isImage && effectiveWatermarkCover.applyToImages !== false) ||
            (item.isVideo && effectiveWatermarkCover.applyToVideos === true))
        ) {
          decorated = { ...decorated, watermarkCover: effectiveWatermarkCover };
        }
        if (!item.isImage || !effectiveWatermarkRemoval) {
          return decorated;
        }
        const prepared = getPreparedImageAsset(item.url);
        if (prepared) {
          return {
            ...decorated,
            url: prepared.forwardUrl,
            sourceUrl: prepared.originalUrl,
            watermarkRemovalState: prepared.watermarkRemovalState,
          };
        }
        if (effectiveWatermarkRemoval.mode === "always") {
          return { ...decorated, watermarkRemoval: effectiveWatermarkRemoval };
        }
        const normalized = normalizeImageUrl(item.url);
        if (watermarkRemovalTargets.has(item.url) || (normalized && watermarkRemovalTargets.has(normalized))) {
          return { ...decorated, watermarkRemoval: effectiveWatermarkRemoval };
        }
        return decorated;
      };
      const shouldUploadEmbedImagesForFeishu = feishuSendersForThis.length > 0 && !skipImages;
      const shouldRewriteEmbedImages =
        ((effectiveWatermarks.length > 0 || !!effectiveWatermarkRemoval || !!effectiveWatermarkCover) ||
          shouldUploadEmbedImagesForFeishu) && !skipImages;

      for (const att of message.attachments.values()) {
        const url = att.url;
        const filename = att.name || "file";
        const ct = (att.contentType || "").toLowerCase();
        const isImage = ct.startsWith("image/") || IMAGE_EXT_RE.test(url) || IMAGE_EXT_RE.test(filename);
        const isVideo = ct.startsWith("video/") || VIDEO_EXT_RE.test(url) || VIDEO_EXT_RE.test(filename);
        const isAudio = ct.startsWith("audio/") || AUDIO_EXT_RE.test(url) || AUDIO_EXT_RE.test(filename);
        const isDocument = ct.includes("application/pdf") ||
          ct.includes("application/msword") ||
          ct.includes("application/vnd.openxmlformats") ||
          DOCUMENT_EXT_RE.test(url) ||
          DOCUMENT_EXT_RE.test(filename);

        // 根据忽略设置跳过特定类型的附件
        if (skipImages && isImage) {
          this.logger.debug(`${logPrefix} [FILTER] Skipping image attachment: ${filename}`);
          continue;
        }
        if (skipAudio && isAudio) {
          this.logger.debug(`${logPrefix} [FILTER] Skipping audio attachment: ${filename}`);
          continue;
        }
        if (skipVideo && isVideo) {
          this.logger.debug(`${logPrefix} [FILTER] Skipping video attachment: ${filename}`);
          continue;
        }
        if (skipDocuments && isDocument) {
          this.logger.debug(`${logPrefix} [FILTER] Skipping document attachment: ${filename}`);
          continue;
        }

        if (isImage) hasCurrentImage = true;
        uploads.push(decorateUpload({ url, filename, isImage, isVideo }));
      }

      const extraImages = collectImageAssets(message);
      const seenUploads = new Set<string>();
      for (const item of uploads) {
        seenUploads.add(item.url);
        const normalized = normalizeImageUrl(item.url);
        if (normalized) seenUploads.add(normalized);
        if (item.sourceUrl) {
          seenUploads.add(item.sourceUrl);
          const normalizedSource = normalizeImageUrl(item.sourceUrl);
          if (normalizedSource) seenUploads.add(normalizedSource);
        }
      }
      if (!skipImages && extraImages.length > 0) {
        for (const asset of extraImages) {
          if (!asset.url) continue;
          const normalized = normalizeImageUrl(asset.url);
          if (seenUploads.has(asset.url) || (normalized && seenUploads.has(normalized))) continue;
          seenUploads.add(asset.url);
          if (normalized) seenUploads.add(normalized);
          const filename = buildImageFilename(asset.url, ++imageIndex, asset.name);
          uploads.push(decorateUpload({
            url: asset.url,
            filename,
            isImage: true,
          }));
        }
      }
      if (shouldRewriteEmbedImages) {
        const embedUrls = collectEmbedImageUrls(message.embeds || []);
        for (const url of embedUrls) {
          if (!url) continue;
          const normalized = normalizeImageUrl(url);
          if (seenUploads.has(url) || (normalized && seenUploads.has(normalized))) continue;
          seenUploads.add(url);
          if (normalized) seenUploads.add(normalized);
          const filename = buildImageFilename(url, ++imageIndex, "embed");
          uploads.push(decorateUpload({
            url,
            filename,
            isImage: true,
          }));
        }
      }
    } catch {}

    // Tenor/Giphy：恢复为仅发送链接文本以触发 Discord 原生展开（不做直链抓取、不发送附件）
    if (this.RE_GIF.test(rawContent)) {
      originalContent = rawContent.replace(/[<>]/g, "");
        useEmbed = false;
    }

    // 不借用被回复消息的图片：仅转发当前消息自身的附件到同一 Embed

    // 关键修复：将原消息的 embeds 传递给发送器
    // Webhook 消息通常只有 embeds 而没有 content，必须传递 embeds 才能转发
    const channelTranslateMap: Record<string, boolean> = (this.config as any).channelTranslate || {};
    const channelTranslateDirectionMap: Record<string, string> = (this.config as any).channelTranslateDirection || {};
    const translationDirectionForThis = channelTranslateDirectionMap[message.channelId] || 
      (this.config.enableTranslation === true ? "auto" : "off");
    // 如果翻译方向为 "off"，则禁用翻译；否则根据配置决定是否启用
    const enableTranslationForThis = translationDirectionForThis === "off" 
      ? false
      : (channelTranslateMap[message.channelId] !== undefined
          ? channelTranslateMap[message.channelId]
          : this.config.enableTranslation === true);
    const shouldStripEmbedImages = ruleConfig.ignoreImages !== undefined
      ? ruleConfig.ignoreImages
      : this.config.ignoreImages;

    // 构建 extraEmbeds：样式2下回复消息时，添加回复信息的embed；样式1或普通消息时，传递原消息的embeds
    let extraEmbeds: any[] | undefined = undefined;
    if ((forwardStyle === "style2" || forwardStyle === "style3") && style2ReplyEmbed) {
      // 样式2回复消息：添加回复信息的embed，同时保留原消息的embeds（如果有）
      const allEmbeds: any[] = [style2ReplyEmbed];
      if (message.embeds && message.embeds.length > 0) {
        allEmbeds.push(...message.embeds);
      }
      extraEmbeds = allEmbeds;
    } else if ((forwardStyle === "style2" || forwardStyle === "style3") && message.embeds && message.embeds.length > 0) {
      // 样式2普通消息：传递原消息的 embeds（修复 webhook 消息转发问题）
      extraEmbeds = message.embeds;
    } else if (message.embeds && message.embeds.length > 0) {
      // 样式1或其他情况：传递原消息的 embeds（这对于 webhook 消息至关重要）
      extraEmbeds = message.embeds;
    }
    if (forwardStyle === "style3") {
      extraEmbeds = stripEmbedTitles(extraEmbeds);
    }
    extraEmbeds = stripEmbedText(extraEmbeds, stripOptions);
    extraEmbeds = shouldStripEmbedImages
      ? stripAllEmbedImages(extraEmbeds)
      : stripBlockedEmbedImages(extraEmbeds, ocrBlockedImageUrls);
    const finalUploads = filterBlockedUploads(uploads, ocrBlockedImageUrls);
    extraEmbeds = stripUploadedEmbedImages(extraEmbeds, finalUploads);
    const finalImageUrlToFilename = new Map<string, string>();
    for (const item of finalUploads) {
      if (!item.isImage) continue;
      finalImageUrlToFilename.set(item.url, item.filename);
      const normalized = normalizeImageUrl(item.url);
      if (normalized) {
        finalImageUrlToFilename.set(normalized, item.filename);
      }
      if (item.sourceUrl) {
        finalImageUrlToFilename.set(item.sourceUrl, item.filename);
        const normalizedSource = normalizeImageUrl(item.sourceUrl);
        if (normalizedSource) {
          finalImageUrlToFilename.set(normalizedSource, item.filename);
        }
      }
    }
    if (effectiveWatermarks.length > 0 || !!effectiveWatermarkRemoval || !!effectiveWatermarkCover) {
      extraEmbeds = replaceEmbedImageUrls(extraEmbeds, finalImageUrlToFilename);
    }
    const toSend = [{
      content: `${discordContent}`.trim(),
      sourceMessageId: message.id,
      replyToSourceMessageId: message.reference?.messageId,
      replyToTarget,
      username,
      avatarUrl,
      useEmbed,
      uploads: finalUploads,
      extraEmbeds,
      enableTranslationOverride: enableTranslationForThis,
      translationDirection: translationDirectionForThis as any,
      ruleReplacementsDictionary: ruleConfig.replacementsDictionary,
      stripEnglish,
      stripChinese,
      watermark: effectiveWatermarks[0],
      watermarkSecondary: effectiveWatermarks[1],
      watermarks: effectiveWatermarks,
    }];

    if ((this.config as any).mobileClientTarget?.enabled === true) {
      try {
        await forwardDiscordMessageToMobileClient((this.config as any).mobileClientTarget, {
          channelId: message.channelId,
          channelName: ruleConfig.mobileClientChannelName || (message.channel as any)?.name,
          channelAvatarUrl: ruleConfig.mobileClientChannelAvatarUrl,
          guildId: (message.guild as any)?.id,
          guildName: (message.guild as any)?.name,
          categoryName: ruleConfig.mobileClientCategoryName,
          messageId: message.id,
          author: username || authorLabel,
          authorId: message.author?.id,
          authorAvatarUrl: avatarUrl,
          content: `${discordContent}`.trim(),
          createdAt: new Date(message.createdTimestamp || Date.now()).toISOString(),
          attachments: finalUploads.map((item: any) => ({
            id: item.sourceUrl || item.url,
            url: item.url,
            filename: item.filename,
            contentType: item.isImage ? "image/*" : item.isVideo ? "video/*" : "",
          })),
          embeds: extraEmbeds || [],
          reference:
            replyUserNameForStyle2 || replyContentForStyle2
              ? {
                  messageId: message.reference?.messageId,
                  author: replyUserNameForStyle2,
                  content: replyContentForStyle2,
                }
              : null,
        });
      } catch (error: any) {
        this.logger.error(`${logPrefix} [MOBILE] 转发到手机客户端失败: ${String(error?.message || error)}`);
      }
    }

    // 在发送前写入去重缓存，避免特殊频道同一源消息在快速多次更新时重复发送

    // 检查 Discord 转发开关
    const enableDiscordForward = this.config.enableDiscordForward !== false;
    const shouldSendDiscord = sendersForThis.length > 0 && enableDiscordForward;
    if (sendersForThis.length > 0 && !enableDiscordForward) {
      this.logger.info(`${logPrefix} [SKIP] Discord 转发已关闭，跳过转发`);
    }

    this.logger.info(`${logPrefix} [SEND] Preparing to send message (contentLength=${discordContent.length}, uploads=${finalUploads.length}, useEmbed=${useEmbed}, style=${forwardStyle})`);
    if (shouldSendDiscord) {
      const pendingMappings = new Map<string, TargetMessageRef[]>();
      // 遍历所有匹配的 SenderBot，向每个 webhook 发送消息
      for (let senderIndex = 0; senderIndex < sendersForThis.length; senderIndex++) {
        const senderForThis = sendersForThis[senderIndex];
        try {
          const results = await senderForThis.sendData(toSend);
          if (results && results.length > 0) {
            const first = results[0];
            if (first.sourceMessageId) {
              const authorTag = isWebhook
                ? (webhookName !== "unknown" ? webhookName : "Webhook")
                : (message.author?.tag || message.author?.username || "未知用户");
              const contentPreview = collectMessageTextPieces(message).join("\n").trim();
              const contentDisplay = formatLogPreview(contentPreview, 120);
              const hasAttachments = (message.attachments?.size || 0) > 0;
              const hasEmbeds = (message.embeds?.length || 0) > 0;
              const isReply = !!message.reference;
              const attachmentCount = message.attachments?.size || 0;

              let logMsg = `${logPrefix} [SUCCESS] 转发成功 [${senderIndex + 1}/${sendersForThis.length}]: 作者: ${isWebhook ? "🔗 " : "@"}${authorTag} | 源频道: ${message.channelId} | 目标频道: ${first.targetChannelId}`;
              logMsg += `\n  内容: ${contentDisplay}`;
              if (hasAttachments) logMsg += ` | 附件数: ${attachmentCount}`;
              if (hasEmbeds) logMsg += ` | 嵌入: ${message.embeds.length}`;
              if (isReply) logMsg += ` | 回复消息`;
              if (isWebhook) logMsg += ` | Webhook消息`;
              logMsg += `\n  源消息ID: ${first.sourceMessageId} -> 目标消息ID: ${first.targetMessageId}`;

              console.log(logMsg);
              this.logger.info(logMsg);
              recordForwardStat(getStatsAccountId(this.config), "discord-to-discord");
            } else {
              this.logger.warn(`${logPrefix} [WARN] Send result missing sourceMessageId [${senderIndex + 1}/${sendersForThis.length}]`);
            }

            const sourceMessageId = first.sourceMessageId;
            if (sourceMessageId) {
              const collected = pendingMappings.get(sourceMessageId) || [];
              for (const item of results) {
                if (item.targetChannelId && item.targetMessageId) {
                  collected.push({
                    channelId: item.targetChannelId,
                    messageId: item.targetMessageId,
                  });
                }
              }
              pendingMappings.set(sourceMessageId, collected);
            }
          } else {
            this.logger.warn(`${logPrefix} [WARN] Send failed or returned no results [${senderIndex + 1}/${sendersForThis.length}]`);
          }
        } catch (err: any) {
          this.logger.error(`${logPrefix} [ERROR] Send failed [${senderIndex + 1}/${sendersForThis.length}]: ${String(err?.message || err)}`);
        }
      }
      for (const [sourceId, targets] of pendingMappings.entries()) {
        this.setSourceMapping(sourceId, targets);
      }
    }

    // 检查飞书转发开关（飞书不受样式开关影响，始终使用 finalContent）
    const enableFeishuForward = this.config.enableFeishuForward === true;
    const shouldSendFeishu = feishuSendersForThis.length > 0 && enableFeishuForward;
    if (feishuSendersForThis.length > 0 && !enableFeishuForward) {
      this.logger.info(`${logPrefix} [SKIP] 飞书转发已关闭，跳过转发`);
    }
    if (shouldSendFeishu) {
      const feishuContent = stripLanguages(
        String(
          applyReplacementDictionary(
            String(applyReplacementDictionary(feishuContentWithLinks, this.config.replacementsDictionary || {})),
            ruleConfig.replacementsDictionary || {},
          ),
        ),
        stripOptions,
      );
      const feishuEmbeds = shouldStripEmbedImages
        ? stripAllEmbedImages(stripEmbedText(message.embeds, stripOptions))
        : stripBlockedEmbedImages(
            stripEmbedText(message.embeds, stripOptions),
            ocrBlockedImageUrls,
          );
      const finalFeishuEmbeds = stripUploadedEmbedImages(feishuEmbeds, finalUploads);
      for (let senderIndex = 0; senderIndex < feishuSendersForThis.length; senderIndex++) {
        const feishuRuntime = feishuSendersForThis[senderIndex];
        const feishuSender = feishuRuntime.sender;
        if (!this.shouldSendToRuleTarget({
          rule: feishuRuntime.rule,
          message,
          isWebhook,
          senderNameHay,
          textHay,
          hasTextForKeywords,
          caseInsensitive,
          logPrefix,
          targetLabel: feishuSender.target,
        })) {
          continue;
        }
        try {
          const hideDiscordLinks = feishuRuntime.rule?.hideDiscordLinks === true || ruleConfig.hideDiscordLinks === true;
          const contentForFeishu = hideDiscordLinks ? hideDiscordLinksInText(feishuContent) : feishuContent;
          const embedsForFeishu = hideDiscordLinks ? hideDiscordLinksInEmbeds(finalFeishuEmbeds) : finalFeishuEmbeds;
          await feishuSender.send({
            content: contentForFeishu,
            username: username,
            avatarUrl: avatarUrl,
            attachments: finalUploads.map((u) => ({
              url: u.url,
              filename: u.filename,
              isImage: u.isImage,
              watermarkRemoval: u.watermarkRemoval,
              watermarkRemovalState: u.watermarkRemovalState,
              watermarkCover: u.watermarkCover,
            })),
            embeds: embedsForFeishu && embedsForFeishu.length > 0 ? embedsForFeishu : undefined,
            watermark: effectiveWatermarks[0],
            watermarkSecondary: effectiveWatermarks[1],
            watermarks: effectiveWatermarks,
          });
          const feishuPreview = formatLogPreview(contentForFeishu);
          const imageCount = finalUploads.filter((u) => u.isImage).length;
          const logMsg =
            `${logPrefix} [FEISHU] 转发成功 [${senderIndex + 1}/${feishuSendersForThis.length}] | 来自: ${authorLabel} | 源: ${message.channelId} | ` +
            `目标: ${feishuSender.target} | 内容: ${feishuPreview} | 附件: ${finalUploads.length} | 图片: ${imageCount}`;
          console.log(logMsg);
          this.logger.info(logMsg);
          recordForwardStat(getStatsAccountId(this.config), "discord-to-feishu");
        } catch (err: any) {
          const feishuPreview = formatLogPreview(feishuContentWithLinks);
          const errorMsg =
            `${logPrefix} [FEISHU] 转发失败 [${senderIndex + 1}/${feishuSendersForThis.length}] | 来自: ${authorLabel} | 源: ${message.channelId} | ` +
            `目标: ${feishuSender.target} | 内容: ${feishuPreview} | 错误: ${String(err?.message || err)}`;
          console.error(errorMsg);
          this.logger.error(errorMsg);
        }
      }
    }

    if (dingtalkSendersForThis.length > 0) {
      const dingtalkContent = stripLanguages(
        String(
          applyReplacementDictionary(
            String(applyReplacementDictionary(feishuContentWithLinks, this.config.replacementsDictionary || {})),
            ruleConfig.replacementsDictionary || {},
          ),
        ),
        stripOptions,
      );
      const dingtalkEmbeds = shouldStripEmbedImages
        ? stripAllEmbedImages(stripEmbedText(message.embeds, stripOptions))
        : stripBlockedEmbedImages(
            stripEmbedText(message.embeds, stripOptions),
            ocrBlockedImageUrls,
          );
      const finalDingtalkEmbeds = stripUploadedEmbedImages(dingtalkEmbeds, finalUploads);
      for (let senderIndex = 0; senderIndex < dingtalkSendersForThis.length; senderIndex++) {
        const sender = dingtalkSendersForThis[senderIndex];
        try {
          await sender.send({
            content: dingtalkContent,
            username,
            attachments: finalUploads.map((u) => ({
              url: u.url,
              filename: u.filename,
              isImage: u.isImage,
              isVideo: u.isVideo,
            })),
            embeds: finalDingtalkEmbeds && finalDingtalkEmbeds.length > 0 ? finalDingtalkEmbeds : undefined,
          });
          const preview = formatLogPreview(dingtalkContent);
          this.logger.info(
            `${logPrefix} [DINGTALK] 转发成功 [${senderIndex + 1}/${dingtalkSendersForThis.length}] | 来自: ${authorLabel} | 源: ${message.channelId} | 目标: ${sender.target} | 内容: ${preview}`,
          );
          recordForwardStat(getStatsAccountId(this.config), "discord-to-dingtalk");
        } catch (err: any) {
          const errorMsg = `${logPrefix} [DINGTALK] 转发失败 [${senderIndex + 1}/${dingtalkSendersForThis.length}] | 来自: ${authorLabel} | 源: ${message.channelId} | 目标: ${sender.target} | 错误: ${String(err?.message || err)}`;
          console.error(errorMsg);
          this.logger.error(errorMsg);
        }
      }
    }

    if (safewSendersForThis.length > 0) {
      const safewContent = stripLanguages(
        String(
          applyReplacementDictionary(
            String(applyReplacementDictionary(feishuContentWithLinks, this.config.replacementsDictionary || {})),
            ruleConfig.replacementsDictionary || {},
          ),
        ),
        stripOptions,
      );
      const safewEmbeds = shouldStripEmbedImages
        ? stripAllEmbedImages(stripEmbedText(message.embeds, stripOptions))
        : stripBlockedEmbedImages(
            stripEmbedText(message.embeds, stripOptions),
            ocrBlockedImageUrls,
          );
      const finalSafewEmbeds = stripUploadedEmbedImages(safewEmbeds, finalUploads);
      const pendingMappings: TargetMessageRef[] = [];
      for (let senderIndex = 0; senderIndex < safewSendersForThis.length; senderIndex++) {
        const sender = safewSendersForThis[senderIndex];
        try {
          const result = await sender.send({
            content: safewContent,
            sourceMessageId: message.id,
            replyToTargetMessageId: replyToTarget?.messageId,
            attachments: finalUploads.map((u) => ({
              url: u.url,
              filename: u.filename,
              isImage: u.isImage,
              isVideo: u.isVideo,
            })),
            embeds: finalSafewEmbeds && finalSafewEmbeds.length > 0 ? finalSafewEmbeds : undefined,
          });
          if (result?.targetMessageId) {
            pendingMappings.push({
              channelId: result.targetChannelId,
              messageId: result.targetMessageId,
            });
          }
          const preview = formatLogPreview(safewContent);
          this.logger.info(
            `${logPrefix} [SAFEW] 转发成功 [${senderIndex + 1}/${safewSendersForThis.length}] | 来自: ${authorLabel} | 源: ${message.channelId} | 目标: ${sender.chatId} | 内容: ${preview}`,
          );
          recordForwardStat(getStatsAccountId(this.config), "discord-to-safew" as any);
        } catch (err: any) {
          const errorMsg = `${logPrefix} [SAFEW] 转发失败 [${senderIndex + 1}/${safewSendersForThis.length}] | 来自: ${authorLabel} | 源: ${message.channelId} | 目标: ${sender.chatId} | 错误: ${String(err?.message || err)}`;
          console.error(errorMsg);
          this.logger.error(errorMsg);
        }
      }
      if (pendingMappings.length > 0) {
        this.setSourceMapping(message.id, pendingMappings);
      }
    }

    // Telegram 转发 - 只要有匹配的 discord-to-telegram 规则就尝试转发
    const telegramMappings = telegramForwardEnabled ? telegramConfig?.mappings || [] : [];
    const discordToTelegramMappings = telegramMappings.filter(
      (m: any) => m.type === 'discord-to-telegram' && m.sourceChannelId === message.channelId
    );

    if (discordToTelegramMappings.length > 0) {
      const isSystemMessage = (message as any).system === true;
      const rawType = (message as any).type;
      const isNonDefaultType = rawType !== undefined && rawType !== null && rawType !== "DEFAULT" && rawType !== 0;
      const hasForwardContent =
        (message.content && message.content.trim().length > 0) ||
        (message.attachments && message.attachments.size > 0) ||
        (message.embeds && message.embeds.length > 0);

      if (isSystemMessage || isNonDefaultType || !hasForwardContent) {
        this.logger.info(`${logPrefix} [TELEGRAM] Skip system/empty message (type=${String(rawType)})`);
        return;
      }
      const bridgeClient = getTelegramBridgeClient();
      if (bridgeClient) {
        for (const mapping of discordToTelegramMappings) {
          try {
            // 准备消息内容 - 对于Telegram使用原始内容,让Python端处理翻译
            let contentForTelegram = appendDiscordComponentLinks(message.content || "", messageComponents);
            const globalReplacementDictionary = this.config.replacementsDictionary || {};
            const ruleReplacementDictionary =
              (mapping as any).replacementsDictionary || ruleConfig.replacementsDictionary || {};
            contentForTelegram = String(
              applyReplacementDictionary(
                String(applyReplacementDictionary(contentForTelegram, globalReplacementDictionary)),
                ruleReplacementDictionary,
              ),
            );
            contentForTelegram = stripLanguages(contentForTelegram, stripOptions);
            const contentPreview = formatLogPreview(contentForTelegram);
            const replacedTelegramEmbeds = applyReplacementDictionaryToEmbeds(
              applyReplacementDictionaryToEmbeds(message.embeds, globalReplacementDictionary),
              ruleReplacementDictionary,
            );
            const telegramEmbeds = shouldStripEmbedImages
              ? stripAllEmbedImages(stripEmbedText(replacedTelegramEmbeds, stripOptions))
              : stripBlockedEmbedImages(
                  stripEmbedText(replacedTelegramEmbeds, stripOptions),
                  ocrBlockedImageUrls,
                );
            const finalTelegramEmbeds = stripUploadedEmbedImages(telegramEmbeds, finalUploads);

            // 准备消息数据
            const messageData = {
              channelId: message.channelId,
              message: {
                id: message.id,
                content: contentForTelegram,
                author: {
                  username: username,
                  avatarURL: undefined,
                  displayName: message.member?.displayName || message.author?.username || message.author?.tag,
                },
                attachments: finalUploads.map((u) => ({
                  url: u.url,
                  filename: u.filename,
                  isImage: u.isImage,
                  isVideo: u.isVideo,
                  contentType: u.isImage ? "image/jpeg" : u.isVideo ? "video/mp4" : "application/octet-stream",
                  watermarkRemoval: u.watermarkRemoval,
                  watermarkRemovalState: u.watermarkRemovalState,
                  watermarkCover: u.watermarkCover,
                })),
                embeds: finalTelegramEmbeds && finalTelegramEmbeds.length > 0 ? finalTelegramEmbeds : undefined,
                watermark: effectiveWatermarks[0],
                watermarkSecondary: effectiveWatermarks[1],
                watermarks: effectiveWatermarks,
              },
              // 传递翻译配置给Python端
              translate: mapping.translate || false,
              translateDirection: mapping.translateDirection || 'auto',
            };

            // 发送到 Telegram Bridge
            await bridgeClient.handleDiscordMessage(messageData);

            const logMsg =
              `${logPrefix} [TELEGRAM] 转发成功 | 来自: ${authorLabel} | 源: ${message.channelId} | ` +
              `目标: ${mapping.targetChannelId} | 内容: ${contentPreview} | 附件: ${finalUploads.length}`;
            console.log(logMsg);
            this.logger.info(logMsg);
            recordForwardStat(getStatsAccountId(this.config), "discord-to-telegram");
          } catch (err: any) {
            const errorMsg =
              `${logPrefix} [TELEGRAM] 转发失败 | 来自: ${authorLabel} | 源: ${message.channelId} | ` +
              `目标: ${mapping.targetChannelId} | 错误: ${String(err?.message || err)}`;
            console.error(errorMsg);
            this.logger.error(errorMsg);
          }
        }
      } else {
        this.logger.warn(`${logPrefix} [TELEGRAM] Telegram Bridge 客户端未初始化，跳过转发`);
      }
    }
  }

  private async resolveFullMessage(message: Message | PartialMessage): Promise<Message | PartialMessage> {
    const msgAny = message as any;
    if (msgAny?.partial && typeof msgAny.fetch === "function") {
      try {
        return await msgAny.fetch();
      } catch (err: any) {
        this.logger.warn(`messageUpdate fetch partial message failed: ${String(err?.message || err)}`);
      }
    }
    return message;
  }

  private getDeleteSendersForTarget(senders: SenderBot[], target: TargetMessageRef): SenderBot[] {
    const matching = senders.filter((sender) => {
      const senderAny = sender as any;
      const channelId = String(senderAny.targetChannelId || senderAny.defaultChannelId || "").trim();
      return channelId && channelId === target.channelId;
    });
    if (matching.length > 0) return matching;
    if (senders.length === 1) return senders;

    const unresolved = senders.filter((sender) => {
      const senderAny = sender as any;
      return !senderAny.targetChannelId && !senderAny.defaultChannelId;
    });
    return unresolved.length > 0 ? unresolved : senders;
  }

  private async handleMessageDelete(message: Message | PartialMessage) {
    const messageAny = message as any;
    const sourceMessageId = String(messageAny?.id || "").trim();
    if (!sourceMessageId) return;

    if (this.sourceToTarget.size === 0) {
      await this.loadMapping();
    }

    const mappedTargets = this.getMappedTargets(sourceMessageId);
    if (mappedTargets.length === 0) {
      this.logger.debug(`[DELETE] Skip delete, no target mapping for source ${sourceMessageId}`);
      return;
    }

    if (this.config.enableDiscordForward === false) {
      return;
    }

    const sourceChannelId = String(messageAny?.channelId || messageAny?.channel?.id || "").trim();
    if (!sourceChannelId) {
      this.logger.warn(`[DELETE] Source channel missing for message ${sourceMessageId}, skip delete sync`);
      return;
    }

    const sendersForThis = this.getSendersForChannel(sourceChannelId);
    if (sendersForThis.length === 0) {
      this.logger.warn(`[DELETE] No Discord sender found for source channel ${sourceChannelId}, skip delete sync`);
      return;
    }

    this.logger.info(
      `[DELETE] Received source delete: message=${sourceMessageId} channel=${sourceChannelId} targets=${mappedTargets.length}`,
    );

    let successCount = 0;
    for (const target of mappedTargets) {
      let deleted = false;
      let lastError: any;
      for (const sender of this.getDeleteSendersForTarget(sendersForThis, target)) {
        try {
          await sender.deleteForwardedMessage({
            targetChannelId: target.channelId,
            targetMessageId: target.messageId,
          });
          deleted = true;
          successCount++;
          break;
        } catch (err: any) {
          lastError = err;
        }
      }
      if (!deleted) {
        this.logger.warn(
          `[DELETE] Sync failed for source ${sourceMessageId} -> ${target.channelId}/${target.messageId}: ${String(
            lastError?.message || lastError,
          )}`,
        );
      }
    }

    if (successCount === mappedTargets.length) {
      this.sourceToTarget.delete(sourceMessageId);
      this.isMappingDirty = true;
      await this.saveMapping();
      this.logger.info(
        `[DELETE] Sync success: source ${sourceMessageId} deleted ${successCount}/${mappedTargets.length} target message(s)`,
      );
      return;
    }

    this.logger.warn(
      `[DELETE] Sync partial: source ${sourceMessageId} deleted ${successCount}/${mappedTargets.length} target message(s), mapping retained`,
    );
  }

  private async handleMessageUpdate(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) {
    const sourceMessageId = String((newMessage as any)?.id || (oldMessage as any)?.id || "");
    if (!sourceMessageId) return;

    if (this.sourceToTarget.size === 0) {
      await this.loadMapping();
    }

    const mappedTargets = this.getMappedTargets(sourceMessageId);
    if (mappedTargets.length === 0) {
      this.logger.debug(`[EDIT] Skip update, no target mapping for source ${sourceMessageId}`);
      return;
    }

    const resolvedMessage = await this.resolveFullMessage(newMessage);
    const sourceChannelId = String((resolvedMessage as any)?.channelId || (oldMessage as any)?.channelId || "");
    if (!sourceChannelId) {
      this.logger.warn(`[EDIT] Source channel missing for message ${sourceMessageId}, skip edit sync`);
      return;
    }

    const sendersForThis = this.getSendersForChannel(sourceChannelId);
    if (sendersForThis.length === 0) {
      this.logger.warn(`[EDIT] No sender found for source channel ${sourceChannelId}, skip edit sync`);
      return;
    }
    if (this.config.enableDiscordForward === false) {
      return;
    }

    this.logger.info(
      `[EDIT] Received source update: message=${sourceMessageId} channel=${sourceChannelId} targets=${mappedTargets.length}`,
    );

    const messageAny = resolvedMessage as any;
    const ruleConfig = this.getRuleLevelConfig(sourceChannelId);
    const stripEnglish = this.config.stripEnglish === true || ruleConfig.stripEnglish === true;
    const stripChinese = this.config.stripChinese === true || ruleConfig.stripChinese === true;
    const stripOptions = { stripEnglish, stripChinese };

    let renderOutput: RenderOutput = { content: String(messageAny?.content || "") };
    try {
      renderOutput = await this.messageAction(resolvedMessage as Message);
    } catch (err: any) {
      this.logger.warn(`[EDIT] mention render failed, fallback to raw content: ${String(err?.message || err)}`);
    }
    const rawContent = String(messageAny?.content || "").trim();
    let originalContent = (renderOutput.content || "").trim();
    let useEmbed = true;

    try {
      const rawContentCleaned = rawContent.replace(/\p{Cf}/gu, "");
      const aliasFilterRaw = rawContentCleaned.replace(/[^:\sA-Za-z0-9_~+\.-]/gu, "");
      const isOnlyAliasEmotes = /^(?:\s*:[A-Za-z0-9_~+\.-]+:\s*)+$/u.test(aliasFilterRaw);
      const strictAlias = (() => {
        const t = rawContent.replace(/\p{Cf}/gu, "").trim();
        return t.startsWith(":") && t.endsWith(":") && !/[\n\r]/.test(t);
      })();
      if (isOnlyAliasEmotes || strictAlias) {
        originalContent = rawContent;
        useEmbed = false;
      }
    } catch {}

    if (this.RE_TWITTER.test(rawContent)) {
      originalContent = rawContent.replace(/[<>]/g, "");
      useEmbed = false;
    }
    if (this.RE_GIF.test(rawContent)) {
      originalContent = rawContent.replace(/[<>]/g, "");
      useEmbed = false;
    }

    const rawStyle = (this.config as any).feishuStyle;
    const forwardStyle = rawStyle === "style2" || rawStyle === "style3" ? rawStyle : "style1";
    let discordContent = originalContent || "";

    if (forwardStyle === "style2") {
      useEmbed = false;
      if (!rawContent && (messageAny?.embeds?.length || 0) > 0) {
        useEmbed = true;
      }
    } else if (forwardStyle === "style3") {
      useEmbed = true;
    }

    const longMessageConfig = ruleConfig.longMessage;
    if (longMessageConfig?.enabled) {
      discordContent = applyLongMessageConfig(discordContent, longMessageConfig);
    }

    let extraEmbeds: any[] | undefined = undefined;
    const incomingEmbeds: any[] = Array.isArray(messageAny?.embeds) ? messageAny.embeds : [];
    if (incomingEmbeds.length > 0) {
      extraEmbeds = stripEmbedText(incomingEmbeds, stripOptions);
      if (forwardStyle === "style3") {
        extraEmbeds = stripEmbedTitles(extraEmbeds);
      }
    }

    const channelTranslateMap: Record<string, boolean> = (this.config as any).channelTranslate || {};
    const channelTranslateDirectionMap: Record<string, string> =
      (this.config as any).channelTranslateDirection || {};
    const translationDirectionForThis =
      channelTranslateDirectionMap[sourceChannelId] || (this.config.enableTranslation === true ? "auto" : "off");
    const enableTranslationForThis =
      translationDirectionForThis === "off"
        ? false
        : channelTranslateMap[sourceChannelId] !== undefined
          ? channelTranslateMap[sourceChannelId]
          : this.config.enableTranslation === true;

    let successCount = 0;
    for (const target of mappedTargets) {
      let synced = false;
      let lastError: any;
      for (const sender of sendersForThis) {
        try {
          await sender.editForwardedMessage({
            targetChannelId: target.channelId,
            targetMessageId: target.messageId,
            content: discordContent,
            useEmbed,
            extraEmbeds,
            enableTranslationOverride: enableTranslationForThis,
            translationDirection: translationDirectionForThis as any,
            ruleReplacementsDictionary: ruleConfig.replacementsDictionary,
            stripEnglish,
            stripChinese,
          });
          synced = true;
          successCount++;
          break;
        } catch (err: any) {
          lastError = err;
        }
      }
      if (!synced) {
        this.logger.warn(
          `[EDIT] Sync failed for source ${sourceMessageId} -> ${target.channelId}/${target.messageId}: ${String(
            lastError?.message || lastError,
          )}`,
        );
      }
    }

    if (successCount > 0) {
      this.logger.info(
        `[EDIT] Sync success: source ${sourceMessageId} updated ${successCount}/${mappedTargets.length} target message(s)`,
      );
      this.setSourceMapping(sourceMessageId, mappedTargets);
    }
  }

  // 在目标频道历史消息中尝试解析出某个 sourceId 的映射
  private async tryResolveMappingFromTarget(sourceId: string, senderForThis?: SenderBot): Promise<{ channelId: string; messageId: string } | undefined> {
    try {
      const clientAny = this.client as any;
      if (!clientAny || !clientAny.channels || typeof clientAny.channels.fetch !== "function") {
        return undefined;
      }
      let configured: string[] = [];
      if (this.config.historyScan?.channels && this.config.historyScan.channels.length > 0) {
        configured = this.config.historyScan.channels;
      } else {
        // Auto collect: all known target channels
        const set = new Set<string>();
        try {
          // from all sender bots defaultChannelId
          for (const sb of (this.senderBotsBySource?.values() || [])) {
            const id = (sb as any).defaultChannelId as string | undefined;
            if (id) set.add(id);
          }
        } catch {}
        configured = Array.from(set);
      }
      const unlimited = !this.config.historyScan || this.config.historyScan.limit === undefined || (Number(this.config.historyScan.limit) <= 0);
      const hardCap = unlimited ? Number.POSITIVE_INFINITY : Math.max(1, Number(this.config.historyScan!.limit));

      for (const channelId of configured) {
        try {
          const ch: any = await (this.client as any).channels.fetch(channelId);
          if (!ch || !ch.messages) continue;
          let lastId: string | undefined = undefined;
          let scanned = 0;
          while (unlimited || scanned < hardCap) {
            const step = unlimited ? 100 : Math.min(100, hardCap - scanned);
            const batch: any = await ch.messages.fetch({ limit: step, ...(lastId ? { before: lastId } : {}) });
            const arr = Array.from(batch.values()) as any[];
            if (arr.length === 0) break;
            for (const m of arr) {
              scanned++;
              lastId = m.id;
              const embeds: any[] = (m.embeds || []) as any[];
              for (const e of embeds) {
                const footerText: string | undefined = e?.footer?.text;
                if (footerText && footerText.trim() === `sid:${sourceId}`) {
                  const found = { channelId, messageId: m.id };
                  this.setSourceMapping(sourceId, [found]);
                  this.logger.debug(`historyScan hit by footer: source=${sourceId} target=${channelId}/${m.id}`);
                  return found;
                }
              }
              const content: string = (m.content || "") as string;
              if (content.includes(sourceId)) {
                const found = { channelId, messageId: m.id };
                this.setSourceMapping(sourceId, [found]);
                this.logger.debug(`historyScan hit by content: source=${sourceId} target=${channelId}/${m.id}`);
                return found;
              }
            }
            if (arr.length < (unlimited ? 100 : Math.min(100, hardCap - scanned))) break;
          }
        } catch (e: any) {
          // 跳过无权限的频道
          this.logger.error(`historyScan channel skipped (no access?): ${channelId} error=${String(e)}`);
          continue;
        }
      }
    } catch (e) {
      console.error(e);
      this.logger.error(`tryResolveMappingFromTarget failed: ${String(e)}`);
    }
    return undefined;
  }

  async messageAction(
    message: Message<boolean> | PartialMessage,
    tag?: string
  ) {
    let render = "";
    const allAttachments: string[] = [];

    // 用户可见内容：仅进行 mention 渲染，不包含调试信息
    render += await this.renderMentions(
      message.content ?? "",
      message.mentions.users.values(),
      message.mentions.channels.values(),
      message.mentions.roles.values()
    );

    // 精简日志：只在debug模式下记录基本信息，避免大量消息时I/O阻塞
    // 详细的embed和attachment信息已在processAndSend中记录

    return { content: render } as RenderOutput;
  }

  

  async renderMentions(
    text: string,
    users: IterableIterator<User>,
    channels: IterableIterator<AnyChannel>,
    roles: IterableIterator<Role>
  ) {
    for (const user of users) {
      text = text.replace(`<@${user.id}>`, `@${user.displayName}`);
    }

    for (const channel of channels) {
      try {
        const anyChannel: any = channel as any;
        if (anyChannel?.name) {
          text = text.replace(`<#${channel.id}>`, `#${anyChannel.name}`);
          continue;
        }
        if (typeof anyChannel?.fetch === "function") {
          const fetchedChannel = await anyChannel.fetch();
          text = text.replace(`<#${channel.id}>`, `#${(fetchedChannel as any).name}`);
          continue;
        }
        text = text.replace(`<#${channel.id}>`, `#${channel.id}`);
      } catch (e) {
        this.logger.error(`renderMentions failed to fetch channel: ${String(e)}`);
      }
    }

    for (const role of roles) {
      text = text.replace(`<@&${role.id}>`, `@${role.name}`);
    }

    return text;
  }
}
