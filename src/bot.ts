import {
  AnyChannel,
  Client as SelfBotClient,
  Message,
  PartialMessage,
  Role,
  User
} from "discord.js-selfbot-v13";
import { Client as BotClient } from "discord.js";

import { Config } from "./config.js";
import { formatSize } from "./format.js";
import { SenderBot } from "./senderBot.js";
import { FileLogger } from "./logger.js";
import { promises as fs } from "node:fs";
import path from "node:path";

interface RenderOutput {
  content: string;
}

export type Client<Ready extends boolean = boolean> =
  | SelfBotClient<Ready>
  | BotClient<Ready>;

export class Bot {
  senderBot: SenderBot; // default sender
  private senderBotsBySource?: Map<string, SenderBot>;
  config: Config;
  client: Client;
  // 源消息ID -> 目标消息ID映射（用于构建目标内跳转链接）
  // 使用带大小限制的 Map，防止内存无限增长
  private sourceToTarget = new Map<string, { channelId: string; messageId: string; timestamp: number }>();
  private mapFile = path.resolve(process.cwd(), ".data", "message_map.json");
  private logger = new FileLogger();
  // 使用 Set 来跟踪正在处理的消息ID，避免重复处理
  private processingMessages = new Set<string>();
  // Map 最大条目数，超过时删除最旧的（保留最近 5000 条映射，减少内存占用）
  private readonly MAX_MAP_SIZE = 5000;
  // 定期保存定时器
  private saveMappingTimer?: NodeJS.Timeout;
  // process 事件处理器引用，用于清理
  private beforeExitHandler?: () => void;
  private sigintHandler?: () => void;
  private sigtermHandler?: () => void;
  
  constructor(client: Client, config: Config, senderBot: SenderBot, senderBotsBySource?: Map<string, SenderBot>) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;

    // 移除所有旧的事件监听器，避免重复注册
    (this.client as any).removeAllListeners("ready");
    (this.client as any).removeAllListeners("error");
    (this.client as any).removeAllListeners("shardError");
    (this.client as any).removeAllListeners("warn");
    (this.client as any).removeAllListeners("messageCreate");

    (this.client as any).on("ready", (clientArg: Client<true>) => {
      const msg = `Logged into Discord as @${clientArg.user?.tag}!`;
      console.log(msg);
      this.logger.info(msg);
    });

    // 监听客户端错误，避免 ECONNRESET 直接导致进程崩溃
    (this.client as any).on("error", (err: any) => {
      this.logger.error(`client error: ${String(err?.stack || err)}`);
    });
    (this.client as any).on?.("shardError", (err: any) => {
      this.logger.error(`shard error: ${String(err?.stack || err)}`);
    });
    (this.client as any).on("warn", (info: any) => {
      this.logger.debug(`client warn: ${String(info)}`);
    });

    (this.client as any).on("messageCreate", async (message: Message) => {
      // 简化监听器：所有处理逻辑都在 processAndSend 中
      await this.processAndSend(message);
    });

    // 定期保存映射（每 5 分钟保存一次，减少 I/O）
    this.saveMappingTimer = setInterval(() => {
      this.saveMapping().catch(err => {
        this.logger.error(`定期保存映射失败: ${String(err)}`);
      });
    }, 5 * 60 * 1000);

    // 程序退出时保存映射
    // 注意：由于 process 是全局的，多个 Bot 实例会重复添加监听器
    // 但每个 Bot 实例的 saveMapping 是独立的，所以需要每个实例都保存
    // 为了避免内存泄漏，每个实例都会在 cleanup 时移除自己的监听器
    this.beforeExitHandler = () => {
      this.saveMapping().catch(() => {});
    };
    this.sigintHandler = () => {
      this.saveMapping().catch(() => {});
      // 注意：不要在这里调用 process.exit(0)，因为 index.ts 中已经有处理
    };
    this.sigtermHandler = () => {
      this.saveMapping().catch(() => {});
      // 注意：不要在这里调用 process.exit(0)，因为 index.ts 中已经有处理
    };
    
    // 为每个 Bot 实例添加监听器（每个实例需要保存自己的映射）
    process.on("beforeExit", this.beforeExitHandler);
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);

    // 为了支持"回复可跳转"，改为单条即时发送（如需保留堆叠，可另加配置开关）
  }

  /**
   * 清理资源，停止定时器等
   */
  cleanup() {
    if (this.saveMappingTimer) {
      clearInterval(this.saveMappingTimer);
      this.saveMappingTimer = undefined;
    }
    // 移除 process 事件监听器（如果存在）
    if (this.beforeExitHandler) {
      process.removeListener("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = undefined;
    }
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      this.sigintHandler = undefined;
    }
    if (this.sigtermHandler) {
      process.removeListener("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = undefined;
    }
    // 保存映射
    this.saveMapping().catch(() => {});
    // 清理 processingMessages Set，释放内存
    this.processingMessages.clear();
  }

  /**
   * 在不重启进程的情况下，更新运行时使用的配置和转发映射。
   * 供外部在检测到 config.json / .env 变更后调用。
   */
  updateRuntimeConfig(config: Config, defaultSender: SenderBot, senderBotsBySource?: Map<string, SenderBot>) {
    this.config = config;
    this.senderBot = defaultSender;
    this.senderBotsBySource = senderBotsBySource;
    this.logger.info("runtime config updated: channelWebhooks / blockedKeywords 已刷新");
  }

  private getSenderForChannel(channelId: string): SenderBot | undefined {
    return this.senderBotsBySource?.get(channelId);
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
      const json = JSON.parse(buf) as Record<string, { channelId: string; messageId: string; timestamp?: number }>;
      const now = Date.now();
      // 加载时添加时间戳（如果旧数据没有时间戳，使用当前时间）
      const entries: Array<[string, { channelId: string; messageId: string; timestamp: number }]> = 
        Object.entries(json).map(([key, value]) => [
          key,
          { ...value, timestamp: value.timestamp || now }
        ] as [string, { channelId: string; messageId: string; timestamp: number }]);
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
      // 只保存必要的字段，不保存 timestamp（减少文件大小）
      const obj: Record<string, { channelId: string; messageId: string }> = {};
      for (const [key, value] of this.sourceToTarget.entries()) {
        obj[key] = { channelId: value.channelId, messageId: value.messageId };
      }
      const tmp = this.mapFile + ".tmp";
      await fs.writeFile(tmp, JSON.stringify(obj), "utf-8");
      await fs.rename(tmp, this.mapFile);
    } catch {}
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
    // 检查是否正在处理此消息，避免重复处理
    if (this.processingMessages.has(message.id)) {
      this.logger.debug(`[DUPLICATE] Message ${message.id} is already being processed, skipping`);
      return;
    }
    
    // 标记消息为正在处理
    this.processingMessages.add(message.id);
    
    // 5秒后自动清理，防止内存泄漏
    // 同时限制 Set 大小，防止在高频消息下无限增长
    // 使用 WeakRef 或直接限制大小，避免定时器累积
    const messageId = message.id;
    const cleanupTimer = setTimeout(() => {
      this.processingMessages.delete(messageId);
      // 如果 Set 过大（超过 1000），清理最旧的条目（保留最新的 1000 条）
      if (this.processingMessages.size > 1000) {
        const toDelete = Array.from(this.processingMessages).slice(0, this.processingMessages.size - 1000);
        toDelete.forEach(id => this.processingMessages.delete(id));
      }
    }, 5000);
    
    // 使用 unref() 让定时器不阻止进程退出，减少内存占用
    if (typeof cleanupTimer.unref === "function") {
      cleanupTimer.unref();
    }

    // 懒加载历史映射（进程首次消息时）
    if (this.sourceToTarget.size === 0) {
      await this.loadMapping();
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
    
    this.logger.info(`${logPrefix} [START] Processing message: channel=${message.channelId} id=${message.id} ${authorInfo}`);
    this.logger.info(`${logPrefix} [CONTENT] content="${(message.content || "").substring(0, 200)}" contentLength=${message.content?.length || 0} embeds=${message.embeds?.length || 0} attachments=${message.attachments?.size || 0}`);
    
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
    try {
      const isTwitterOnly = /^<?https?:\/\/(?:x\.com|twitter\.com)\/\S+>?$/i.test(rawContent);
      if (isTwitterOnly) {
        originalContent = rawContent.replace(/[<>]/g, "");
        useEmbed = false;
      }
    } catch {}

    // GIF 链接的处理移动到附件收集之后

    // 路由：仅当该源频道在映射中时才转发；未映射则跳过
    const senderForThis = this.getSenderForChannel(message.channelId);
    if (!senderForThis) {
      this.logger.info(`${logPrefix} [SKIP] Channel ${message.channelId} not mapped in channelWebhooks`);
      return;
    }
    this.logger.info(`${logPrefix} [ROUTE] Found mapping for channel ${message.channelId}, will forward to webhook`);

    // 用户过滤：白名单（allowedUsersIds）与黑名单（mutedUsersIds）
    // 注意：webhook 消息的 author 可能为 null，需要特殊处理
    try {
      const authorId = message.author?.id;
      
      // 如果是 webhook 消息，跳过用户ID过滤（因为 webhook 没有用户ID）
      if (!isWebhook && authorId) {
        const allowed = (this.config.allowedUsersIds || []).map((x: any) => String(x)).filter(Boolean);
        const muted = (this.config.mutedUsersIds || []).map((x: any) => String(x)).filter(Boolean);
        if (allowed.length > 0 && !allowed.includes(authorId)) {
          this.logger.info(`${logPrefix} [SKIP] Author ${authorId} not in allowedUsersIds (allowed=${allowed.join(",")})`);
          return;
        }
        if (muted.length > 0 && muted.includes(authorId)) {
          this.logger.info(`${logPrefix} [SKIP] Author ${authorId} in mutedUsersIds (muted=${muted.join(",")})`);
          return;
        }
        this.logger.info(`${logPrefix} [FILTER] User ID filter passed (allowed=${allowed.length} muted=${muted.length})`);
      } else if (isWebhook) {
        this.logger.info(`${logPrefix} [FILTER] Webhook message, skipping user ID filter`);
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] User filter check failed: ${String(e?.message || e)}`);
    }

    // keyword filter: if list non-empty, only forward messages containing at least one keyword
    try {
      const kws = (this.config.blockedKeywords || []).filter(Boolean);
      if (kws.length > 0) {
        const lower = (s: string) => s.toLowerCase();
        const pieces: string[] = [];
        pieces.push(message.content || "");
        // 检查所有embed字段：description, title, footer.text, author.name, fields
        try { 
          for (const e of (message.embeds || [])) { 
            if (e.description) pieces.push(String(e.description));
            if (e.title) pieces.push(String(e.title));
            if (e.footer?.text) pieces.push(String(e.footer.text));
            if (e.author?.name) pieces.push(String(e.author.name));
            if (e.fields) {
              for (const field of e.fields) {
                if (field.name) pieces.push(String(field.name));
                if (field.value) pieces.push(String(field.value));
              }
            }
          } 
        } catch {}
        const hay = lower(pieces.join("\n"));
        const matchedKeywords: string[] = [];
        for (const k of kws) {
          if (hay.includes(lower(k))) {
            matchedKeywords.push(k);
          }
        }
        if (matchedKeywords.length === 0) {
          this.logger.info(`${logPrefix} [SKIP] No required keyword matched (keywords=${kws.join(",")}, content="${(message.content || "").substring(0, 100)}", embeds=${message.embeds?.length || 0})`);
          return;
        }
        this.logger.info(`${logPrefix} [FILTER] Keyword filter passed (matched=${matchedKeywords.join(",")}, required=${kws.join(",")})`);
      } else {
        this.logger.info(`${logPrefix} [FILTER] No keyword filter configured, passing`);
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] Keyword filter check failed: ${String(e?.message || e)}`);
    }

    // exclude keywords: skip message entirely if it contains any of them
    try {
      const excludes = (this.config.excludeKeywords || []).filter(Boolean);
      if (excludes.length > 0) {
        const lower = (s: string) => s.toLowerCase();
        const pieces: string[] = [];
        pieces.push(message.content || "");
        // 检查所有embed字段：description, title, footer.text, author.name, fields
        try { 
          for (const e of (message.embeds || [])) { 
            if (e.description) pieces.push(String(e.description));
            if (e.title) pieces.push(String(e.title));
            if (e.footer?.text) pieces.push(String(e.footer.text));
            if (e.author?.name) pieces.push(String(e.author.name));
            if (e.fields) {
              for (const field of e.fields) {
                if (field.name) pieces.push(String(field.name));
                if (field.value) pieces.push(String(field.value));
              }
            }
          } 
        } catch {}
        const hay = lower(pieces.join("\n"));
        const matchedExcludes: string[] = [];
        for (const k of excludes) {
          if (hay.includes(lower(k))) {
            matchedExcludes.push(k);
          }
        }
        if (matchedExcludes.length > 0) {
          this.logger.info(`${logPrefix} [SKIP] Exclude keyword matched (matched=${matchedExcludes.join(",")}, excludes=${excludes.join(",")})`);
          return;
        }
        this.logger.info(`${logPrefix} [FILTER] Exclude keyword filter passed (excludes=${excludes.join(",")})`);
      } else {
        this.logger.info(`${logPrefix} [FILTER] No exclude keyword filter configured, passing`);
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] Exclude keyword filter check failed: ${String(e?.message || e)}`);
    }
    let replyToTarget: { channelId: string; messageId: string } | undefined;
    let ctaLine: string | undefined;
    if (message.reference) {
      try {
        const ref = await message.fetchReference();
        const mappedEntry = this.sourceToTarget.get(ref.id);
        let mapped = mappedEntry ? { channelId: mappedEntry.channelId, messageId: mappedEntry.messageId } : undefined;
        // 不重发，改为：若无映射，尝试在目标历史中扫描已有消息并建立映射
        if (!mapped) {
          try {
            const found = await this.tryResolveMappingFromTarget(ref.id, senderForThis);
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
          // 无论是否有附件/Embed，都生成 CTA 行；有资产时用“查看附件”，否则用“查看消息”
          if (senderForThis.webhookGuildId) {
            const link = `https://discord.com/channels/${senderForThis.webhookGuildId}/${mapped.channelId}/${mapped.messageId}`;
            let display: string;
            if (this.config.showSourceIdentity) {
              // 显示源用户名称
              display = (ref.member as any)?.displayName || ref.author?.username || ref.author?.tag || "用户";
            } else {
              // 使用 webhook 名称
              display = (senderForThis as any).webhookName || "Webhook";
            }
            const hasAssets = (ref.attachments?.size ?? 0) > 0 || (ref.embeds?.length ?? 0) > 0;
            const label = hasAssets ? "查看附件" : "查看消息";
            ctaLine = `↳ @${display}: [${label}](${link})`;
          }
        }
      } catch (err) {
        console.error(err);
        this.logger.error(`fetchReference failed: ${String(err)}`);
      }
    }

    // 拼装最终内容：CTA 在顶部
    const parts: string[] = [];
    if (ctaLine) parts.push(ctaLine);
    if (originalContent) parts.push(originalContent);
    const finalContent = parts.join("\n");

    // 根据配置决定是否伪装为源用户头像和昵称
    // 对于 webhook 消息，使用 webhook 的名称和头像
    let username: string | undefined = undefined;
    let avatarUrl: string | undefined = undefined;
    
    if (this.config.showSourceIdentity) {
      try {
        if (isWebhook) {
          // Webhook 消息：使用之前获取的webhookName（避免重复获取）
          username = webhookName !== "unknown" ? webhookName : "Webhook";
          // webhook的头像可能在webhook对象中，也可能在author中
          avatarUrl = (message as any).webhook?.avatar 
            || (message as any).avatarURL
            || (message.author as any)?.displayAvatarURL?.({ size: 128, format: "png" })
            || (message.author as any)?.avatarURL?.({ size: 128, format: "png" });
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
    const uploads: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }> = [];
    let hasCurrentImage = false;
    try {
      for (const att of message.attachments.values()) {
        const url = att.url;
        const filename = att.name || "file";
        const ct = (att.contentType || "").toLowerCase();
        const isImage = ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);
        const isVideo = ct.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(url);
        if (isImage) hasCurrentImage = true;
        uploads.push({ url, filename, isImage, isVideo });
      }
    } catch {}

    // Tenor/Giphy：恢复为仅发送链接文本以触发 Discord 原生展开（不做直链抓取、不发送附件）
    try {
      const gifOnly = /^<?https?:\/\/(?:tenor\.com|giphy\.com)\/\S+>?$/i.test(rawContent);
      if (gifOnly) {
        const pageUrl = rawContent.replace(/[<>]/g, "");
        originalContent = pageUrl;
        useEmbed = false;
      }
    } catch (e) {
      this.logger.error(`tenor/giphy handling failed: ${String(e)}`);
    }

    // 不借用被回复消息的图片：仅转发当前消息自身的附件到同一 Embed

    // 关键修复：将原消息的 embeds 传递给发送器
    // Webhook 消息通常只有 embeds 而没有 content，必须传递 embeds 才能转发
    const toSend = [{
      content: `${finalContent}`.trim(),
      sourceMessageId: message.id,
      replyToSourceMessageId: message.reference?.messageId,
      replyToTarget,
      username,
      avatarUrl,
      useEmbed,
      uploads,
      // 传递原消息的 embeds，这对于 webhook 消息至关重要
      extraEmbeds: message.embeds && message.embeds.length > 0 ? message.embeds : undefined
    }];

    // 在发送前写入去重缓存，避免特殊频道同一源消息在快速多次更新时重复发送
    
    this.logger.info(`${logPrefix} [SEND] Preparing to send message (contentLength=${finalContent.length}, uploads=${uploads.length}, useEmbed=${useEmbed})`);
    const results = await senderForThis.sendData(toSend);
    if (results && results.length > 0) {
      const first = results[0];
      if (first.sourceMessageId) {
        // 优化：先删除旧的（如果存在），确保重新 set 后它在 Map 的末尾（变为最新）
        // 这样可以利用 Map 的自然顺序实现 LRU，无需排序
        if (this.sourceToTarget.has(first.sourceMessageId)) {
          this.sourceToTarget.delete(first.sourceMessageId);
        }
        
        // 设置新的映射，由于是重新插入，它会位于 Map 的末尾（最新位置）
        this.sourceToTarget.set(first.sourceMessageId, {
          channelId: first.targetChannelId,
          messageId: first.targetMessageId,
          timestamp: Date.now()
        });
        // 限制 Map 大小，防止内存无限增长
        this.limitMapSize();
        // 不再每次保存，改为定期保存（由定时器处理）
        
        // 构建详细的转发日志（使用之前获取的webhookName）
        const authorTag = isWebhook 
          ? (webhookName !== "unknown" ? webhookName : "Webhook")
          : (message.author?.tag || message.author?.username || "未知用户");
        const contentPreview = (message.content || "").trim();
        const contentDisplay = contentPreview.length > 100 
          ? contentPreview.substring(0, 100) + "..." 
          : contentPreview || "(无文本内容)";
        const hasAttachments = (message.attachments?.size || 0) > 0;
        const hasEmbeds = (message.embeds?.length || 0) > 0;
        const isReply = !!message.reference;
        const attachmentCount = message.attachments?.size || 0;
        
        let logMsg = `${logPrefix} [SUCCESS] 转发成功: 作者: ${isWebhook ? "🔗 " : "@"}${authorTag} | 源频道: ${message.channelId} | 目标频道: ${first.targetChannelId}`;
        logMsg += `\n  内容: ${contentDisplay}`;
        if (hasAttachments) logMsg += ` | 附件数: ${attachmentCount}`;
        if (hasEmbeds) logMsg += ` | 嵌入: ${message.embeds.length}`;
        if (isReply) logMsg += ` | 回复消息`;
        if (isWebhook) logMsg += ` | Webhook消息`;
        logMsg += `\n  源消息ID: ${first.sourceMessageId} -> 目标消息ID: ${first.targetMessageId}`;
        
        console.log(logMsg);
        this.logger.info(logMsg);
      } else {
        this.logger.warn(`${logPrefix} [WARN] Send result missing sourceMessageId`);
      }
    } else {
      this.logger.warn(`${logPrefix} [WARN] Send failed or returned no results`);
    }
  }

  // 在目标频道历史消息中尝试解析出某个 sourceId 的映射
  private async tryResolveMappingFromTarget(sourceId: string, senderForThis?: SenderBot): Promise<{ channelId: string; messageId: string } | undefined> {
    try {
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
                  // 优化：先删除旧的（如果存在），确保重新 set 后它在 Map 的末尾
                  if (this.sourceToTarget.has(sourceId)) {
                    this.sourceToTarget.delete(sourceId);
                  }
                  this.sourceToTarget.set(sourceId, { ...found, timestamp: Date.now() });
                  this.limitMapSize();
                  this.logger.debug(`historyScan hit by footer: source=${sourceId} target=${channelId}/${m.id}`);
                  return found;
                }
              }
              const content: string = (m.content || "") as string;
              if (content.includes(sourceId)) {
                const found = { channelId, messageId: m.id };
                // 优化：先删除旧的（如果存在），确保重新 set 后它在 Map 的末尾
                if (this.sourceToTarget.has(sourceId)) {
                  this.sourceToTarget.delete(sourceId);
                }
                this.sourceToTarget.set(sourceId, { ...found, timestamp: Date.now() });
                this.limitMapSize();
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
        const fetchedChannel = await channel.fetch();

        text = text.replace(
          `<#${channel.id}>`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          `#${(fetchedChannel as any).name}`
        );
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