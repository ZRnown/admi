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
import { getTelegramBridgeClient } from "./index.js";
import { formatKeywordGroups, matchParsedKeywordGroups, parseKeywordGroups } from "./keywordMatcher.js";
import { clampPercent, getLanguageRatio } from "./languageFilter.js";
import { promises as fs } from "node:fs";
import path from "node:path";

interface RenderOutput {
  content: string;
}

export type Client<Ready extends boolean = boolean> =
  | SelfBotClient<Ready>
  | BotClient<Ready>;

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
    if (contentType.startsWith("image/") || (url && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url))) {
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
    if (imageUrl && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(imageUrl)) {
      urls.push(imageUrl);
    }
    if (rawUrl && /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(rawUrl)) {
      urls.push(rawUrl);
    }
  }
  return urls;
}

function hasImageInEmbeds(embeds: any[]): boolean {
  return collectEmbedImageUrls(embeds).length > 0;
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
      if (!url) continue;
      if (contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url)) {
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
    senderBotsBySource?: Map<string, SenderBot[]>,
    feishuSendersBySource?: Map<string, FeishuSender>,
  ) {
    this.config = config;
    this.senderBot = senderBot;
    this.client = client;
    this.senderBotsBySource = senderBotsBySource;
    this.feishuSendersBySource = feishuSendersBySource;

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
    senderBotsBySource?: Map<string, SenderBot[]>,
    feishuSendersBySource?: Map<string, FeishuSender>,
  ) {
    this.config = config;
    this.senderBot = defaultSender;
    this.senderBotsBySource = senderBotsBySource;
    this.feishuSendersBySource = feishuSendersBySource;

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

  private getSendersForChannel(channelId: string): SenderBot[] {
    return this.senderBotsBySource?.get(channelId) || [];
  }

  private hasOcrFilters(config: Config): boolean {
    if ((config.ocrBlockedKeywords?.length || 0) > 0 || (config.ocrTriggerKeywords?.length || 0) > 0) {
      return true;
    }
    const hasRuleOcr = (rule: any) =>
      (rule?.ocrBlockedKeywords?.length || 0) > 0 || (rule?.ocrTriggerKeywords?.length || 0) > 0;
    const mappings = (config as any).mappings || [];
    for (const rule of mappings) {
      if (hasRuleOcr(rule)) return true;
    }
    const telegramMappings = (config as any).telegramConfig?.mappings || [];
    for (const rule of telegramMappings) {
      if (hasRuleOcr(rule)) return true;
    }
    const feishuRuleConfigs = (config as any).feishuRuleConfigs || {};
    for (const rule of Object.values(feishuRuleConfigs)) {
      if (hasRuleOcr(rule)) return true;
    }
    return false;
  }

  private getFeishuSenderForChannel(channelId: string): FeishuSender | undefined {
    return this.feishuSendersBySource?.get(channelId);
  }

  /**
   * 获取指定频道的规则级别完整配置
   * 返回该频道规则的所有过滤配置
   * 同时查找顶层 mappings 和 telegramConfig.mappings
   */
  private getRuleLevelConfig(channelId: string): {
    allowedUsersIds: string[];
    mutedUsersIds: string[];
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
    ignoreSelf?: boolean;
    ignoreBot?: boolean;
    ignoreImages?: boolean;
    ignoreAudio?: boolean;
    ignoreVideo?: boolean;
    ignoreDocuments?: boolean;
    ignoreEnglish?: boolean;
    ignoreEnglishThreshold?: number;
    ignoreChinese?: boolean;
    ignoreChineseThreshold?: number;
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
      const feishuRuleConfigs = (this.config as any).feishuRuleConfigs || {};
      rule = feishuRuleConfigs[channelId];
    }

    if (!rule) {
      return {
        allowedUsersIds: [],
        mutedUsersIds: [],
        blockedKeywords: [],
        excludeKeywords: [],
        ocrBlockedKeywords: [],
        ocrTriggerKeywords: [],
        longMessage: undefined,
        replacementsDictionary: {},
        ignoreSelf: undefined,
        ignoreBot: undefined,
        ignoreImages: undefined,
        ignoreAudio: undefined,
        ignoreVideo: undefined,
        ignoreDocuments: undefined,
        ignoreEnglish: undefined,
        ignoreEnglishThreshold: undefined,
        ignoreChinese: undefined,
        ignoreChineseThreshold: undefined,
      };
    }
    return {
      allowedUsersIds: (rule.allowedUsersIds || []).map((x: any) => String(x)).filter(Boolean),
      mutedUsersIds: (rule.mutedUsersIds || []).map((x: any) => String(x)).filter(Boolean),
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
      ignoreSelf: rule.ignoreSelf,
      ignoreBot: rule.ignoreBot,
      ignoreImages: rule.ignoreImages,
      ignoreAudio: rule.ignoreAudio,
      ignoreVideo: rule.ignoreVideo,
      ignoreDocuments: rule.ignoreDocuments,
      ignoreEnglish: rule.ignoreEnglish,
      ignoreEnglishThreshold: rule.ignoreEnglishThreshold,
      ignoreChinese: rule.ignoreChinese,
      ignoreChineseThreshold: rule.ignoreChineseThreshold,
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
    const sendersForThis = this.getSendersForChannel(message.channelId);
    const feishuSenderForThis = this.getFeishuSenderForChannel(message.channelId);

    // 检查是否有 Telegram 映射
    const telegramMappingsCheck = (this.config as any).telegramConfig?.mappings || [];
    const hasTelegramMapping = telegramMappingsCheck.some(
      (m: any) => m.type === 'discord-to-telegram' && m.sourceChannelId === message.channelId
    );

    // 只有在没有任何转发目标时才返回
    if (sendersForThis.length === 0 && !feishuSenderForThis && !hasTelegramMapping) {
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

    this.logger.info(`${logPrefix} [START] Processing message: channel=${message.channelId} id=${message.id} ${authorInfo}`);
    this.logger.info(`${logPrefix} [CONTENT] content="${(message.content || "").substring(0, 200)}" contentLength=${message.content?.length || 0} embeds=${message.embeds?.length || 0} attachments=${message.attachments?.size || 0}`);

    // 获取规则级别配置（提前获取，用于过滤与OCR检查）
    const ruleConfig = this.getRuleLevelConfig(message.channelId);
    const caseInsensitive = this.config.caseInsensitiveKeywords ?? true;

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
        if (hasImage) {
          this.logger.info(`${logPrefix} [SKIP] Ignoring image attachment (ignoreImages=true, rule=${ruleConfig.ignoreImages})`);
          return;
        }
      }

      if (message.attachments && message.attachments.size > 0) {
        for (const att of message.attachments.values()) {
          const ct = (att.contentType || "").toLowerCase();
          const url = (att.url || "").toLowerCase();

          // 忽略音频
          if (shouldIgnoreAudio && (ct.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(url))) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring audio attachment (ignoreAudio=true, rule=${ruleConfig.ignoreAudio})`);
            return;
          }

          // 忽略视频
          if (shouldIgnoreVideo && (ct.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|flv)$/i.test(url))) {
            this.logger.info(`${logPrefix} [SKIP] Ignoring video attachment (ignoreVideo=true)`);
            return;
          }

          // 忽略文档
          if (shouldIgnoreDocuments && (
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

    // OCR 图片检测过滤（全局 + 规则级别）
    try {
      const globalOcrBlocked = parseKeywordGroups(this.config.ocrBlockedKeywords);
      const ruleOcrBlocked = parseKeywordGroups(ruleConfig.ocrBlockedKeywords);
      const allOcrBlocked = [...globalOcrBlocked, ...ruleOcrBlocked];
      const globalOcrTrigger = parseKeywordGroups(this.config.ocrTriggerKeywords);
      const ruleOcrTrigger = parseKeywordGroups(ruleConfig.ocrTriggerKeywords);
      const activeOcrTrigger = globalOcrTrigger.length > 0 ? globalOcrTrigger : ruleOcrTrigger;
      const needsOcrCheck = allOcrBlocked.length > 0 || activeOcrTrigger.length > 0;

      if (needsOcrCheck) {
        const imageAttachments = collectImageAssets(message);

        if (imageAttachments.length > 0) {
          if (!this.ocrClient) {
            const msg = `${logPrefix} [OCR] OCR客户端未初始化，无法检测图片，跳过转发`;
            console.log(`[OCR] ${msg}`);
            this.logger.info(msg);
            return;
          }

          console.log(`[OCR] 消息包含 ${imageAttachments.length} 张图片，开始检测...`);
          this.logger.info(`${logPrefix} [OCR] 开始检测图片中的文字...`);

          let checkedImages = 0;
          let triggerMatched = activeOcrTrigger.length === 0;

          for (const attachment of imageAttachments) {
              const url = attachment.url;
              const contentType = attachment.contentType || "";
              console.log(`[OCR] 检测到图片 ${attachment.name || attachment.url} (类型: ${contentType || "unknown"})`);

            try {
              console.log(`[OCR] 开始OCR识别...`);
              const ocrResult = await this.ocrClient.recognizeImage(url);
              const ocrText = OCRClient.extractText(ocrResult);
              checkedImages++;

              if (allOcrBlocked.length > 0) {
                const { matchedGroups, matchedKeywords } = matchParsedKeywordGroups(ocrText, allOcrBlocked, {
                  caseInsensitive,
                });
                if (matchedGroups.length > 0) {
                  const errorMsg = `${logPrefix} [OCR] 检测到屏蔽文字 "${matchedKeywords.join('", "')}"，跳过转发`;
                  console.log(`[OCR] ${errorMsg}`);
                  this.logger.info(errorMsg);
                  return;
                }
              }

              if (!triggerMatched && activeOcrTrigger.length > 0) {
                const { matchedGroups } = matchParsedKeywordGroups(ocrText, activeOcrTrigger, { caseInsensitive });
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

          const finalMsg = `${logPrefix} [OCR] 图片检测完成，总图片数=${imageAttachments.length}，已检测=${checkedImages}，允许转发`;
          console.log(`[OCR] ${finalMsg}`);
          this.logger.info(finalMsg);
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
    } else if (feishuSenderForThis) {
      this.logger.info(`${logPrefix} [ROUTE] Found Feishu mapping for channel ${message.channelId}, will forward to Feishu`);
    }

    const applyReplacementDictionary = (input: string, dict: Record<string, string>) => {
      let next = input;
      for (const [from, to] of Object.entries(dict || {})) {
        next = next.replaceAll(from, String(to ?? ""));
      }
      return next;
    };

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
            if (this.config.showSourceIdentity) {
              // 显示源用户名称
              display = (ref.member as any)?.displayName || ref.author?.username || ref.author?.tag || "用户";
            } else {
              // 使用 webhook 名称
              display = (firstSender as any).webhookName || "Webhook";
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

    const longMessageConfig = ruleConfig.longMessage;
    if (longMessageConfig?.enabled) {
      discordContent = applyLongMessageConfig(discordContent, longMessageConfig);
    }
    const feishuContentRaw = applyLongMessageConfig(finalContent, longMessageConfig);

    // 根据配置决定是否伪装为源用户头像和昵称
    // 对于 webhook 消息，使用 webhook 的名称和头像
    let username: string | undefined = undefined;
    let avatarUrl: string | undefined = undefined;
    
    if (this.config.showSourceIdentity) {
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
    const uploads: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }> = [];
    let hasCurrentImage = false;
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

      for (const att of message.attachments.values()) {
        const url = att.url;
        const filename = att.name || "file";
        const ct = (att.contentType || "").toLowerCase();
        const isImage = ct.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(url);
        const isVideo = ct.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi)$/i.test(url);
        const isAudio = ct.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(url);
        const isDocument = ct.includes("application/pdf") ||
          ct.includes("application/msword") ||
          ct.includes("application/vnd.openxmlformats") ||
          /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|rtf)$/i.test(url);

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
        uploads.push({ url, filename, isImage, isVideo });
      }

      const extraImages = collectImageAssets(message);
      if (extraImages.length > 0) {
        const seenUploads = new Set(uploads.map((item) => item.url));
        for (const asset of extraImages) {
          if (!asset.url || seenUploads.has(asset.url)) continue;
          seenUploads.add(asset.url);
          uploads.push({
            url: asset.url,
            filename: asset.name || "image",
            isImage: true,
          });
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
      ruleReplacementsDictionary: ruleConfig.replacementsDictionary,
    }];

    // 在发送前写入去重缓存，避免特殊频道同一源消息在快速多次更新时重复发送

    // 检查 Discord 转发开关
    const enableDiscordForward = this.config.enableDiscordForward !== false;
    const shouldSendDiscord = sendersForThis.length > 0 && enableDiscordForward;
    if (sendersForThis.length > 0 && !enableDiscordForward) {
      this.logger.info(`${logPrefix} [SKIP] Discord 转发已关闭，跳过转发`);
    }

    this.logger.info(`${logPrefix} [SEND] Preparing to send message (contentLength=${discordContent.length}, uploads=${uploads.length}, useEmbed=${useEmbed}, style=${forwardStyle})`);
    if (shouldSendDiscord) {
      // 遍历所有匹配的 SenderBot，向每个 webhook 发送消息
      for (let senderIndex = 0; senderIndex < sendersForThis.length; senderIndex++) {
        const senderForThis = sendersForThis[senderIndex];
        try {
          const results = await senderForThis.sendData(toSend);
          if (results && results.length > 0) {
            const first = results[0];
            if (first.sourceMessageId) {
              // 只为第一个 sender 保存映射（用于回复跳转）
              if (senderIndex === 0) {
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
              }

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
            } else {
              this.logger.warn(`${logPrefix} [WARN] Send result missing sourceMessageId [${senderIndex + 1}/${sendersForThis.length}]`);
            }
          } else {
            this.logger.warn(`${logPrefix} [WARN] Send failed or returned no results [${senderIndex + 1}/${sendersForThis.length}]`);
          }
        } catch (err: any) {
          this.logger.error(`${logPrefix} [ERROR] Send failed [${senderIndex + 1}/${sendersForThis.length}]: ${String(err?.message || err)}`);
        }
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
        const feishuContent = applyReplacementDictionary(
          applyReplacementDictionary(feishuContentRaw, this.config.replacementsDictionary || {}),
          ruleConfig.replacementsDictionary || {},
        );
        await feishuSenderForThis.send({
          content: feishuContent,
          username: username,
          avatarUrl: avatarUrl,
          attachments: uploads.map((u) => ({ url: u.url, filename: u.filename, isImage: u.isImage })),
          embeds: message.embeds && message.embeds.length > 0 ? message.embeds : undefined,
        });
        const feishuTarget = feishuSenderForThis.target;
        const feishuPreview = formatLogPreview(feishuContent);
        const imageCount = uploads.filter((u) => u.isImage).length;
        const logMsg =
          `${logPrefix} [FEISHU] 转发成功 | 来自: ${authorLabel} | 源: ${message.channelId} | ` +
          `目标: ${feishuTarget} | 内容: ${feishuPreview} | 附件: ${uploads.length} | 图片: ${imageCount}`;
        console.log(logMsg);
        this.logger.info(logMsg);
      } catch (err: any) {
        const feishuTarget = feishuSenderForThis.target;
        const feishuPreview = formatLogPreview(feishuContentRaw);
        const errorMsg =
          `${logPrefix} [FEISHU] 转发失败 | 来自: ${authorLabel} | 源: ${message.channelId} | ` +
          `目标: ${feishuTarget} | 内容: ${feishuPreview} | 错误: ${String(err?.message || err)}`;
        console.error(errorMsg);
        this.logger.error(errorMsg);
      }
    }

    // Telegram 转发 - 只要有匹配的 discord-to-telegram 规则就尝试转发
    const telegramMappings = (this.config as any).telegramConfig?.mappings || [];
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
            let contentForTelegram = message.content || '';
            contentForTelegram = applyReplacementDictionary(
              applyReplacementDictionary(contentForTelegram, this.config.replacementsDictionary || {}),
              (mapping as any).replacementsDictionary || ruleConfig.replacementsDictionary || {},
            );
            const contentPreview = formatLogPreview(contentForTelegram);

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
                attachments: uploads.map((u) => ({
                  url: u.url,
                  contentType: u.isImage ? 'image' : 'file',
                  name: u.filename,
                })),
                embeds: message.embeds && message.embeds.length > 0 ? message.embeds : undefined,
              },
              // 传递翻译配置给Python端
              translate: mapping.translate || false,
              translateDirection: mapping.translateDirection || 'auto',
            };

            // 发送到 Telegram Bridge
            await bridgeClient.handleDiscordMessage(messageData);

            const logMsg =
              `${logPrefix} [TELEGRAM] 转发成功 | 来自: ${authorLabel} | 源: ${message.channelId} | ` +
              `目标: ${mapping.targetChannelId} | 内容: ${contentPreview} | 附件: ${uploads.length}`;
            console.log(logMsg);
            this.logger.info(logMsg);
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
