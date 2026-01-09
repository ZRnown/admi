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
import { FeishuSender } from "./feishuSender.js";
import { OCRClient } from "./ocrClient.js";
import { FileLogger } from "./logger.js";
import { promises as fs } from "node:fs";
import path from "node:path";

interface RenderOutput {
  content: string;
}

export type Client<Ready extends boolean = boolean> =
  | SelfBotClient<Ready>
  | BotClient<Ready>;

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
  private senderBotsBySource?: Map<string, SenderBot>;
  private feishuSendersBySource?: Map<string, FeishuSender>;
  config: Config;
  client: Client;
  // 源消息ID -> 目标消息ID映射（用于构建目标内跳转链接）
  // 使用带大小限制的 Map，防止内存无限增长
  private sourceToTarget = new Map<string, { channelId: string; messageId: string; timestamp: number }>();
  private mapFile = path.resolve(process.cwd(), ".data", "message_map.json");
  private logger = new FileLogger();
  // 优化：使用无定时器的去重缓存
  private processedIds = new DedupeCache(2000);
  // Map 最大条目数，超过时删除最旧的（保留最近 10000 条映射）
  private readonly MAX_MAP_SIZE = 10000;
  // 定期保存定时器
  private saveMappingTimer?: NodeJS.Timeout;
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
    senderBotsBySource?: Map<string, SenderBot>,
    feishuSendersBySource?: Map<string, FeishuSender>,
  ) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;
    this.feishuSendersBySource = feishuSendersBySource;

    // 初始化OCR客户端 - 自动根据屏蔽词启用/禁用
    const hasOCRKeywords = (config.ocrBlockedKeywords?.length || 0) > 0;
    if (hasOCRKeywords && config.ocrServerUrl) {
      this.ocrClient = new OCRClient(config.ocrServerUrl, undefined); // 不使用代理，直接连接
      console.log(`[Bot] ✅ OCR已自动启用（检测到${config.ocrBlockedKeywords?.length || 0}个屏蔽词），服务器URL: ${config.ocrServerUrl}`);
    } else {
      this.ocrClient = undefined;
      if (!hasOCRKeywords) {
        console.log(`[Bot] ⏸️  OCR已自动禁用（未配置屏蔽词）`);
      } else {
        console.log(`[Bot] ⏸️  OCR已自动禁用（未配置OCR服务器URL）`);
      }
    }

    // 移除所有旧的事件监听器，避免重复注册
    (this.client as any).removeAllListeners("ready");
    (this.client as any).removeAllListeners("error");
    (this.client as any).removeAllListeners("shardError");
    (this.client as any).removeAllListeners("warn");
    (this.client as any).removeAllListeners("messageCreate");

    // 使用 clientReady 替代 ready（Discord.js v15 兼容）
    const readyHandler = (clientArg: Client<true>) => {
      const msg = `Logged into Discord as @${clientArg.user?.tag}!`;
      console.log(msg);
      this.logger.info(msg);
    };
    // 同时监听 ready 和 clientReady 以兼容不同版本
    (this.client as any).on("clientReady", readyHandler);
    (this.client as any).on("ready", readyHandler);

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
    senderBotsBySource?: Map<string, SenderBot>,
    feishuSendersBySource?: Map<string, FeishuSender>,
  ) {
    this.config = config;
    this.senderBot = defaultSender;
    this.senderBotsBySource = senderBotsBySource;
    this.feishuSendersBySource = feishuSendersBySource;

    // 更新OCR配置 - 自动根据屏蔽词启用/禁用
    const hasOCRKeywords = (config.ocrBlockedKeywords?.length || 0) > 0;
    const previousHasOCR = this.ocrClient !== undefined;

    if (hasOCRKeywords && config.ocrServerUrl) {
      if (!previousHasOCR) {
        this.ocrClient = new OCRClient(config.ocrServerUrl, undefined); // 不使用代理，直接连接
        console.log(`[Bot] ✅ OCR已自动启用（新增${config.ocrBlockedKeywords?.length || 0}个屏蔽词）`);
      }
    } else {
      if (previousHasOCR) {
        this.ocrClient = undefined;
        if (!hasOCRKeywords) {
          console.log(`[Bot] ⏸️  OCR已自动禁用（屏蔽词已清空）`);
        } else {
          console.log(`[Bot] ⏸️  OCR已自动禁用（未配置OCR服务器URL）`);
        }
      }
    }

    this.logger.info("runtime config updated: channelWebhooks / blockedKeywords / OCR 已刷新");
  }

  private getSenderForChannel(channelId: string): SenderBot | undefined {
    return this.senderBotsBySource?.get(channelId);
  }

  private getFeishuSenderForChannel(channelId: string): FeishuSender | undefined {
    return this.feishuSendersBySource?.get(channelId);
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
    if (this.sourceToTarget.size === 0) return;
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
      // 只保存必要的字段，不保存 timestamp（减少文件大小）
      const obj: Record<string, { channelId: string; messageId: string }> = {};
      for (const [key, value] of this.sourceToTarget.entries()) {
        obj[key] = { channelId: value.channelId, messageId: value.messageId };
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

    // 快速检查：路由映射是否存在，不存在则快速返回
    const senderForThis = this.getSenderForChannel(message.channelId);
    const feishuSenderForThis = this.getFeishuSenderForChannel(message.channelId);
    if (!senderForThis && !feishuSenderForThis) {
      return; // 快速返回，不做多余计算
    }
    
    // 记录消息检测日志（仅在启用机器人中转时，帮助调试）
    if (senderForThis && senderForThis.enableBotRelay) {
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
    
    this.logger.info(`${logPrefix} [START] Processing message: channel=${message.channelId} id=${message.id} ${authorInfo}`);
    this.logger.info(`${logPrefix} [CONTENT] content="${(message.content || "").substring(0, 200)}" contentLength=${message.content?.length || 0} embeds=${message.embeds?.length || 0} attachments=${message.attachments?.size || 0}`);
    
    // 忽略选项检查
    try {
      // 忽略自己的消息
      if (this.config.ignoreSelf && message.author?.id === (this.client as any).user?.id) {
        this.logger.info(`${logPrefix} [SKIP] Ignoring own message (ignoreSelf=true)`);
        return;
      }
      
      // 忽略机器人消息
      if (this.config.ignoreBot && (message.author?.bot || isWebhook)) {
        this.logger.info(`${logPrefix} [SKIP] Ignoring bot/webhook message (ignoreBot=true)`);
        return;
      }
      
      // 检查附件类型并忽略
      if (message.attachments && message.attachments.size > 0) {
        for (const att of message.attachments.values()) {
          const ct = (att.contentType || "").toLowerCase();
          const url = att.url.toLowerCase();
          
          // 忽略图片
          if (this.config.ignoreImages && (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url))) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring image attachment (ignoreImages=true)`);
            return;
          }
          
          // 忽略音频
          if (this.config.ignoreAudio && (ct.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(url))) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring audio attachment (ignoreAudio=true)`);
            return;
          }
          
          // 忽略视频
          if (this.config.ignoreVideo && (ct.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|flv)$/i.test(url))) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring video attachment (ignoreVideo=true)`);
            return;
          }
          
          // 忽略文档
          if (this.config.ignoreDocuments && (
            ct.includes("application/pdf") ||
            ct.includes("application/msword") ||
            ct.includes("application/vnd.openxmlformats") ||
            /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|rtf)$/i.test(url)
          )) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring document attachment (ignoreDocuments=true)`);
            return;
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`${logPrefix} [ERROR] Ignore filter check failed: ${String(e?.message || e)}`);
    }

    // OCR 图片检测过滤
    try {
      if (this.ocrClient && message.attachments && message.attachments.size > 0) {
        console.log(`[OCR] 消息包含 ${message.attachments.size} 个附件，开始检测图片...`);
        this.logger.info(`${logPrefix} [OCR] 开始检测图片中的文字...`);

        let totalImages = 0;
        let checkedImages = 0;

        for (const attachment of message.attachments.values()) {
          const contentType = attachment.contentType || "";
          const url = attachment.url;

          // 只处理图片
          const isImage = contentType.startsWith("image/") ||
            /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);

          if (isImage) {
            totalImages++;
            console.log(`[OCR] 检测到图片 ${attachment.name || attachment.url} (类型: ${contentType || 'unknown'})`);

            try {
              console.log(`[OCR] 开始OCR识别...`);
              const ocrResult = await this.ocrClient.recognizeImage(url);
              const { shouldBlock, matchedKeywords } = this.ocrClient.checkOCRKeywords(
                ocrResult,
                this.config.ocrBlockedKeywords || []
              );

              checkedImages++;

              if (shouldBlock) {
                const errorMsg = `${logPrefix} [OCR] 检测到敏感文字 "${matchedKeywords.join('", "')}"，跳过转发`;
                console.log(`[OCR] ${errorMsg}`);
                this.logger.info(errorMsg);
                return;
              } else {
                console.log(`[OCR] 图片检测通过，未检测到敏感词`);
              }
            } catch (ocrError: any) {
              const errorMsg = `${logPrefix} [OCR] 识别失败: ${ocrError.message}，继续处理其他附件`;
              console.error(`[OCR] ${errorMsg}`);
              console.error(`[OCR] 错误详情:`, ocrError);
              console.error(`[OCR] 错误堆栈: ${ocrError.stack}`);
              this.logger.error(errorMsg);
            }
          } else {
            console.log(`[OCR] 跳过非图片附件: ${attachment.name || attachment.url}`);
          }
        }

        const finalMsg = `${logPrefix} [OCR] 图片检测完成，总图片数=${totalImages}，已检测=${checkedImages}，允许转发`;
        console.log(`[OCR] ${finalMsg}`);
        this.logger.info(finalMsg);
      } else {
        if (!this.ocrClient) {
          console.log(`[OCR] OCR客户端未初始化，跳过检测`);
        } else if (!message.attachments || message.attachments.size === 0) {
          console.log(`[OCR] 消息无附件，跳过检测`);
        }
      }
    } catch (e: any) {
      const errorMsg = `${logPrefix} [ERROR] OCR filter check failed: ${String(e?.message || e)}`;
      console.error(`[OCR] ${errorMsg}`);
      console.error(`[OCR] 错误堆栈: ${e?.stack || 'N/A'}`);
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

    // 路由：仅当该源频道在映射中时才转发；未映射则跳过（senderForThis 已在前面检查过）
    if (senderForThis) {
      this.logger.info(`${logPrefix} [ROUTE] Found mapping for channel ${message.channelId}, will forward to webhook`);
    } else if (feishuSenderForThis) {
      this.logger.info(`${logPrefix} [ROUTE] Found Feishu mapping for channel ${message.channelId}, will forward to Feishu`);
    }

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
    // 给样式2使用的回复元信息（仅用于格式化文本）
    let replyUserNameForStyle2: string | undefined;
    let replyContentForStyle2: string | undefined;
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
          // 无论是否有附件/Embed，都生成 CTA 行；有资产时用"查看附件"，否则用"查看消息"
          if (senderForThis?.webhookGuildId) {
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
          // 记录被回复用户名称和内容（用于样式2显示）
          replyUserNameForStyle2 = (ref.member as any)?.displayName || ref.author?.username || ref.author?.tag || "用户";
          replyContentForStyle2 = ref.content || (ref.attachments?.size > 0 ? "[附件]" : ref.embeds?.length > 0 ? "[嵌入信息]" : "");
        }
      } catch (err) {
        console.error(err);
        this.logger.error(`fetchReference failed: ${String(err)}`);
      }
    }

    // 根据配置对 Discord->Discord 文本应用样式
    const forwardStyle = (this.config as any).feishuStyle === "style2" ? "style2" : "style1";
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
      // 样式2：普通消息直接发originalContent（不含CTA），回复消息时上面发originalContent，下面发embed
      discordContent = originalContent || "";
      useEmbed = false; // 样式2下，主内容不使用embed

      // 但是，如果消息只有embeds（比如webhook消息），即使在style2模式下也需要使用embed模式
      if (!hasText && message.embeds && message.embeds.length > 0) {
        useEmbed = true;
      }
      
      if (isReplyMessage && replyUserNameForStyle2) {
        // 回复消息：生成一个蓝色嵌入块，包含粗体"💬 回复 用户名"、被回复内容和底部小时间
        const now = new Date(message.createdTimestamp || Date.now());
        const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
        const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
          now.getHours(),
        )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        
        style2ReplyEmbed = {
          color: 0x0000FF, // 蓝色
          description: `**💬 回复 ${replyUserNameForStyle2}**\n${replyContentForStyle2 || ""}`,
          footer: {
            text: `⏰ ${ts}`
          }
        };
      }
    }

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

    // 构建 extraEmbeds：样式2下回复消息时，添加回复信息的embed；样式1或普通消息时，传递原消息的embeds
    let extraEmbeds: any[] | undefined = undefined;
    if (forwardStyle === "style2" && style2ReplyEmbed) {
      // 样式2回复消息：添加回复信息的embed，同时保留原消息的embeds（如果有）
      const allEmbeds: any[] = [style2ReplyEmbed];
      if (message.embeds && message.embeds.length > 0) {
        allEmbeds.push(...message.embeds);
      }
      extraEmbeds = allEmbeds;
    } else if (forwardStyle === "style2" && message.embeds && message.embeds.length > 0) {
      // 样式2普通消息：传递原消息的 embeds（修复 webhook 消息转发问题）
      extraEmbeds = message.embeds;
    } else if (message.embeds && message.embeds.length > 0) {
      // 样式1或其他情况：传递原消息的 embeds（这对于 webhook 消息至关重要）
      extraEmbeds = message.embeds;
    }
    
    const toSend = [{
      content: `${discordContent}`.trim(),
      sourceMessageId: message.id,
      replyToSourceMessageId: message.reference?.messageId,
      replyToTarget,
      username,
      avatarUrl,
      useEmbed,
      uploads,
      extraEmbeds,
      enableTranslationOverride: enableTranslationForThis,
      translationDirection: translationDirectionForThis as any,
    }];

    // 在发送前写入去重缓存，避免特殊频道同一源消息在快速多次更新时重复发送
    
    // 检查 Discord 转发开关
    const enableDiscordForward = this.config.enableDiscordForward !== false;
    const shouldSendDiscord = senderForThis && enableDiscordForward;
    if (senderForThis && !enableDiscordForward) {
      this.logger.info(`${logPrefix} [SKIP] Discord 转发已关闭，跳过转发`);
    }
    
    this.logger.info(`${logPrefix} [SEND] Preparing to send message (contentLength=${discordContent.length}, uploads=${uploads.length}, useEmbed=${useEmbed}, style=${forwardStyle})`);
    if (shouldSendDiscord) {
    const results = await senderForThis.sendData(toSend);
    if (results && results.length > 0) {
      const first = results[0];
      if (first.sourceMessageId) {
        if (this.sourceToTarget.has(first.sourceMessageId)) {
          this.sourceToTarget.delete(first.sourceMessageId);
        }
        this.sourceToTarget.set(first.sourceMessageId, {
          channelId: first.targetChannelId,
          messageId: first.targetMessageId,
          timestamp: Date.now()
        });
        this.limitMapSize();
          this.isMappingDirty = true;
        
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

    // 检查飞书转发开关（飞书不受样式开关影响，始终使用 finalContent）
    const enableFeishuForward = this.config.enableFeishuForward === true;
    const shouldSendFeishu = feishuSenderForThis && enableFeishuForward;
    if (feishuSenderForThis && !enableFeishuForward) {
      this.logger.info(`${logPrefix} [SKIP] 飞书转发已关闭，跳过转发`);
    }
    if (shouldSendFeishu) {
      try {
        await feishuSenderForThis.send({
          content: finalContent,
          username: username,
          avatarUrl: avatarUrl,
          attachments: uploads.map((u) => ({ url: u.url, filename: u.filename, isImage: u.isImage })),
          embeds: message.embeds && message.embeds.length > 0 ? message.embeds : undefined,
        });
        this.logger.info(`${logPrefix} [FEISHU] 转发到飞书成功 (附件数=${uploads.length}, 图片数=${uploads.filter(u => u.isImage).length})`);
      } catch (err: any) {
        this.logger.error(`${logPrefix} [FEISHU] 转发失败: ${String(err?.message || err)}`);
      }
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