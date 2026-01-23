import { Client as SelfBotClient } from "discord.js-selfbot-v13";
import { Client as BotClient, GatewayIntentBits, Partials } from "discord.js";
import { promises as fs } from "fs";
import { watch, stat } from "node:fs";
import path from "node:path";
import { createHash } from "crypto";

import { Bot, Client } from "./bot.js";
import { OCRClient } from "./ocrClient.js";
import {
  getMultiConfig,
  type MultiConfig,
  type AccountConfig,
  accountToLegacyConfig,
  ensureConfigFile,
} from "./config.js";
import { getEnv } from "./env.js";
import { SenderBot } from "./senderBot.js";
import { FeishuSender } from "./feishuSender.js";
import { ProxyAgent } from "proxy-agent";
import { FileLogger } from "./logger.js";
import { telegramBridgeManager } from "./processManager.js";
import { TelegramBridgeClient } from "./telegramBridgeClient.js";

// 全局 Telegram Bridge 客户端
let telegramBridgeClient: TelegramBridgeClient | null = null;

interface RunningAccount {
  account: AccountConfig;
  client: Client;
  bot: Bot;
  senderBotsBySource: Map<string, SenderBot>;
  defaultSenderBot?: SenderBot; // 如果关闭 Discord 转发，可能为 undefined
  feishuSendersBySource?: Map<string, any>;
  isManuallyStopped: boolean; // 标记是否手动停止
  reconnectTimer?: NodeJS.Timeout; // 重连定时器
  reconnectCount: number; // 重连次数
  lastReconnectTime: number; // 上次重连时间
  isLoggingIn?: boolean; // 是否正在登录中，用于防止重复登录
  loginTimeout?: NodeJS.Timeout; // 登录超时定时器
}

const runningAccounts = new Map<string, RunningAccount>();
let currentConfig: MultiConfig | null = null;
const statusFile = path.resolve(process.cwd(), ".data", "status.json");
const ocrClients = new Map<string, { url: string; client: OCRClient }>();
// 记录已经输出过"未配置 token"错误的账号，避免重复日志
const loggedNoTokenAccounts = new Set<string>();
// 记录配置文件的 hash，只在真正变化时才重新读取
let lastConfigHash: string | null = null;
let lastConfigMtime: number = 0;

function getPublicBaseUrl(override?: string): string | null {
  const base =
    currentConfig?.telegramAvatarBaseUrl ||
    override ||
    process.env.PUBLIC_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.BASE_URL ||
    "";
  return base ? base.replace(/\/$/, "") : null;
}

function buildTelegramCdnAvatarUrl(username?: string): string | undefined {
  if (!username) return undefined;
  const cleaned = username.startsWith("@") ? username.slice(1) : username;
  if (!cleaned) return undefined;
  return `https://t.me/i/userpic/320/${encodeURIComponent(cleaned)}.jpg`;
}

function buildTelegramAvatarUrl(
  avatarFile?: string,
  avatarUrl?: string,
  baseOverride?: string,
  username?: string,
): string | undefined {
  if (avatarUrl) return avatarUrl;
  const cdnUrl = buildTelegramCdnAvatarUrl(username);
  const base = getPublicBaseUrl(baseOverride);
  if (base && avatarFile) {
    return `${base}/api/telegram/avatar/${encodeURIComponent(avatarFile)}`;
  }
  return cdnUrl;
}

function getOcrClient(account: AccountConfig): OCRClient | null {
  const serverUrl = account.ocrServerUrl;
  if (!serverUrl) return null;
  const cached = ocrClients.get(account.id);
  if (cached && cached.url === serverUrl) {
    return cached.client;
  }
  const client = new OCRClient(serverUrl, undefined);
  ocrClients.set(account.id, { url: serverUrl, client });
  return client;
}

function formatTimestampFromSeconds(seconds?: number): string {
  const now = seconds ? new Date(seconds * 1000) : new Date();
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function parseFeishuTarget(raw: any): { mode: "webhook" | "thread"; target: string } | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return { mode: "webhook", target: trimmed };
  }
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode === "thread" ? "thread" : "webhook";
  if (mode === "thread") {
    const threadId = typeof raw.threadId === "string" ? raw.threadId.trim() : "";
    if (!threadId) return null;
    return { mode, target: threadId };
  }
  const webhookUrl = typeof raw.webhookUrl === "string" ? raw.webhookUrl.trim() : "";
  if (!webhookUrl) return null;
  return { mode, target: webhookUrl };
}

async function writeStatus(accountId: string, state: string, message?: string) {
  try {
    await fs.mkdir(path.dirname(statusFile), { recursive: true });
    let obj: Record<string, any> = {};
    try {
      const buf = await fs.readFile(statusFile, "utf-8");
      obj = JSON.parse(buf.toString());
    } catch {}
    obj[accountId] = { loginState: state, loginMessage: message || "" };
    await fs.writeFile(statusFile, JSON.stringify(obj, null, 2));
  } catch {}
}

function formatDiscordUserLabel(user: any): string {
  if (!user) return "";
  const tag = typeof user.tag === "string" ? user.tag.trim() : "";
  if (tag) return tag;
  const username = typeof user.username === "string" ? user.username.trim() : "";
  const discriminator = typeof user.discriminator === "string" ? user.discriminator.trim() : "";
  if (username && discriminator && discriminator !== "0" && discriminator !== "0000") {
    return `${username}#${discriminator}`;
  }
  if (username) return username;
  const globalName = typeof user.globalName === "string" ? user.globalName.trim() : "";
  if (globalName) return globalName;
  if (user.id) return `ID:${user.id}`;
  return "";
}

function buildDiscordLoginMessage(user: any, fallback: string): string {
  const label = formatDiscordUserLabel(user);
  return label ? `${fallback}: ${label}` : fallback;
}

async function buildSenderBots(account: AccountConfig, logger: FileLogger) {
  const env = getEnv();
  const senderBotsBySource = new Map<string, SenderBot>();
  const feishuSendersBySource = new Map<string, FeishuSender>();
  let defaultSenderBot: SenderBot | undefined;
  const prepares: Promise<any>[] = [];

  const webhooks = account.enableDiscordForward !== false ? (account.channelWebhooks || {}) : {};
  const feishuWebhooks = account.enableFeishuForward ? account.channelFeishuWebhooks || {} : {};
  const replacements = account.replacementsDictionary || {};
  const proxy = account.proxyUrl || env.PROXY_URL;
  const enableTranslation = account.enableTranslation || false;
  const deepseekApiKey = account.deepseekApiKey;
  const translationProvider = account.translationProvider || "deepseek";
  const translationApiKey = account.translationApiKey || account.deepseekApiKey;
  const translationSecret = account.translationSecret;
  const enableBotRelay = account.enableBotRelay || false;
  const relayById = new Map((account.botRelays || []).map((r) => [r.id, r]));
  // 复用同一个代理实例，避免为每个 webhook 创建独立连接池
  const httpAgent = proxy ? new ProxyAgent(proxy as unknown as any) : undefined;

  if (Object.keys(webhooks).length > 0) {
    for (const [channelId, webhookUrl] of Object.entries(webhooks)) {
      const relayId = account.channelRelayMap?.[channelId];
      const relayToken = relayId ? relayById.get(relayId)?.token?.trim() : undefined;
      const useRelay = enableBotRelay && !!relayToken;
      const sb = new SenderBot({
        replacementsDictionary: replacements,
        webhookUrl,
        httpAgent,
        enableTranslation,
        deepseekApiKey,
        translationProvider,
        translationApiKey,
        translationSecret,
        enableBotRelay: useRelay,
        botRelayToken: relayToken,
      });
      prepares.push(sb.prepare());
      senderBotsBySource.set(channelId, sb);
      if (!defaultSenderBot) defaultSenderBot = sb;
    }
  }

  if (Object.keys(feishuWebhooks).length > 0) {
    for (const [channelId, rawTarget] of Object.entries(feishuWebhooks)) {
      const target = parseFeishuTarget(rawTarget);
      if (!target) continue;
      const fs = new FeishuSender(
        target.target,
        httpAgent,
        account.feishuAppId,
        account.feishuAppSecret,
        { mode: target.mode },
      );
      feishuSendersBySource.set(channelId, fs);
    }
  }

  // 检查是否配置了任何转发规则
  const hasDiscordWebhooks = Object.keys(webhooks).length > 0;
  const hasFeishuWebhooks = Object.keys(feishuWebhooks).length > 0;
  const hasTelegramMappings = (account.telegramConfig?.mappings || []).some(
    (m: any) => m.type === 'discord-to-telegram'
  );

  // 如果没有配置任何转发规则（Discord/Feishu/Telegram），且 Discord 转发未关闭，则报错
  if (!defaultSenderBot && account.enableDiscordForward !== false && !hasTelegramMappings) {
    throw new Error("At least one forwarding rule must be configured (Discord webhook, Feishu webhook, or Telegram mapping).");
  }

  await Promise.all(prepares);

  // 移除重复的 webhook 日志输出，只在日志文件中记录一次
  logger.info(`account "${account.name}" senderBots 构建完成，映射频道数=${senderBotsBySource.size}`);

  return { senderBotsBySource, defaultSenderBot, feishuSendersBySource };
}

function setupTelegramBridgeClient() {
  const bridgeProcess = telegramBridgeManager.getProcess();
  if (!bridgeProcess) {
    console.error("[Main] Telegram Bridge process is not available");
    return;
  }

  if (telegramBridgeClient) {
    telegramBridgeClient.destroy();
  }

  telegramBridgeClient = new TelegramBridgeClient(bridgeProcess);
  console.log("[Main] Telegram Bridge IPC client initialized");

  telegramBridgeClient.on("telegram_message", async (params) => {
    const accounts = currentConfig?.accounts || [];
    for (const account of accounts) {
      // 检查 forwardingType 是否为 telegram-to-discord
      const currentForwardingType = account.forwardingType || 'discord-to-discord';
      if (currentForwardingType !== 'telegram-to-discord') continue;

      if (account.telegramConfig?.enableTelegramForward === false) continue;
      if (params.accountId && params.accountId !== account.id) continue;
      const telegramMappings = account.telegramConfig?.mappings || [];
      const sourceChatId = params.chat_id?.toString();
      const sourceChatUsername =
        typeof params.chat_username === "string" ? params.chat_username : undefined;

      const matchingRules = telegramMappings.filter(
        (m: any) => {
          if (m.type !== "telegram-to-discord") return false;
          const raw = typeof m.sourceChannelId === "string" ? m.sourceChannelId.trim() : "";
          if (!raw) return false;
          if (sourceChatId && raw === sourceChatId) return true;
          if (sourceChatUsername) {
            const normalized = raw.startsWith("@") ? raw.slice(1) : raw;
            return normalized === sourceChatUsername;
          }
          return false;
        },
      );

      if (matchingRules.length === 0) {
        continue;
      }

      let content = params.text || "";
      const mediaItems = Array.isArray(params.media) ? params.media : [];
      const globalRequiredKeywords = (account.blockedKeywords || []).filter(Boolean);
      const globalExcludeKeywords = (account.excludeKeywords || []).filter(Boolean);
      const globalReplacements = account.replacementsDictionary || {};
      const normalizedContent = content.toLowerCase();

      try {
        if (globalRequiredKeywords.length > 0) {
          const matched = globalRequiredKeywords.filter((kw) =>
            normalizedContent.includes(String(kw).toLowerCase()),
          );
          if (matched.length === 0) {
            console.log(`[Main] Telegram message skipped (no required keyword match). chat=${sourceChatId}`);
            continue;
          }
        }
      } catch (e: any) {
        console.error(`[Main] Telegram keyword filter error: ${String(e?.message || e)}`);
      }

      try {
        if (globalExcludeKeywords.length > 0) {
          const matched = globalExcludeKeywords.filter((kw) =>
            normalizedContent.includes(String(kw).toLowerCase()),
          );
          if (matched.length > 0) {
            console.log(`[Main] Telegram message skipped (exclude keyword matched). chat=${sourceChatId}`);
            continue;
          }
        }
      } catch (e: any) {
        console.error(`[Main] Telegram exclude filter error: ${String(e?.message || e)}`);
      }

      try {
        const isImage = (m: any) =>
          m?.type === "photo" || String(m?.mimeType || "").startsWith("image/");
        const isVideo = (m: any) =>
          m?.type === "video" || String(m?.mimeType || "").startsWith("video/");
        const isAudio = (m: any) =>
          m?.type === "audio" || String(m?.mimeType || "").startsWith("audio/");
        const isDocument = (m: any) =>
          m?.type === "document" && !isImage(m) && !isVideo(m) && !isAudio(m);

        const hasImage = Boolean(params.photo) || mediaItems.some(isImage);
        const hasVideo = Boolean(params.video) || mediaItems.some(isVideo);
        const hasAudio = mediaItems.some(isAudio);
        const hasDocument = Boolean(params.document) || mediaItems.some(isDocument);

        if (account.ignoreImages && hasImage) {
          console.log(`[Main] Telegram message skipped (ignoreImages=true). chat=${sourceChatId}`);
          continue;
        }
        if (account.ignoreVideo && hasVideo) {
          console.log(`[Main] Telegram message skipped (ignoreVideo=true). chat=${sourceChatId}`);
          continue;
        }
        if (account.ignoreAudio && hasAudio) {
          console.log(`[Main] Telegram message skipped (ignoreAudio=true). chat=${sourceChatId}`);
          continue;
        }
        if (account.ignoreDocuments && hasDocument) {
          console.log(`[Main] Telegram message skipped (ignoreDocuments=true). chat=${sourceChatId}`);
          continue;
        }
      } catch (e: any) {
        console.error(`[Main] Telegram ignore filter error: ${String(e?.message || e)}`);
      }

      try {
        const ocrKeywords = (account.ocrBlockedKeywords || []).filter(Boolean);
        const hasLocalMedia = mediaItems.some((m: any) => m?.localPath);
        if (ocrKeywords.length > 0 && hasLocalMedia) {
          const ocrClient = getOcrClient(account);
          if (!ocrClient) {
            console.warn(`[Main] OCR server not configured, skipping OCR filter for account ${account.name}`);
          } else {
            let shouldBlock = false;
            for (const item of mediaItems) {
              if (!item?.localPath) continue;
              const result = await ocrClient.recognizeLocalFile(item.localPath);
              const check = ocrClient.checkOCRKeywords(result, ocrKeywords);
              if (check.shouldBlock) {
                shouldBlock = true;
                console.log(`[Main] Telegram message blocked by OCR keywords: ${check.matchedKeywords.join(", ")}`);
                break;
              }
            }
            if (shouldBlock) {
              continue;
            }
          }
        }
      } catch (e: any) {
        console.error(`[Main] Telegram OCR filter error: ${String(e?.message || e)}`);
      }

      for (const rule of matchingRules) {
        try {
          const ruleRequiredKeywords = (rule.blockedKeywords || []).filter(Boolean);
          if (globalRequiredKeywords.length === 0 && ruleRequiredKeywords.length > 0) {
            const matched = ruleRequiredKeywords.filter((kw) =>
              normalizedContent.includes(String(kw).toLowerCase()),
            );
            if (matched.length === 0) {
              console.log(
                `[Main] Telegram message skipped (no rule keyword match). chat=${sourceChatId}`,
              );
              continue;
            }
          }

          const ruleExcludeKeywords = (rule.excludeKeywords || []).filter(Boolean);
          if (ruleExcludeKeywords.length > 0) {
            const matched = ruleExcludeKeywords.filter((kw) =>
              normalizedContent.includes(String(kw).toLowerCase()),
            );
            if (matched.length > 0) {
              console.log(
                `[Main] Telegram message skipped (rule exclude keyword matched). chat=${sourceChatId}`,
              );
              continue;
            }
          }

          let contentForRule = content;
          if (globalReplacements && Object.keys(globalReplacements).length > 0) {
            for (const [from, to] of Object.entries(globalReplacements)) {
              contentForRule = contentForRule.replaceAll(from, String(to ?? ""));
            }
          }
          if (rule.replacementsDictionary && typeof rule.replacementsDictionary === "object") {
            for (const [from, to] of Object.entries(rule.replacementsDictionary)) {
              contentForRule = contentForRule.replaceAll(from, String(to ?? ""));
            }
          }

          console.log(`[Main] Forwarding Telegram chat ${sourceChatId} -> Discord webhook ${rule.targetChannelId}`);
          const tempSender = new SenderBot({
            webhookUrl: rule.targetChannelId,
          });

          const forwardStyle = account.feishuStyle === "style2" ? "style2" : "style1";
          const showSourceIdentity = account.showSourceIdentity === true;
          const senderDisplayName =
            params.from_display_name ||
            params.from_username ||
            "Telegram User";
          const avatarUrl = showSourceIdentity
            ? buildTelegramAvatarUrl(
                params.from_avatar_file,
                params.from_avatar_url,
                account.publicBaseUrl,
                params.from_username,
              )
            : undefined;

          let useEmbed = forwardStyle === "style1";
          let extraEmbeds: any[] | undefined;

          const replyInfo = params.reply_to || params.reply_to_message;
          if (replyInfo) {
            const replyUser = replyInfo.from_user || {};
            const replyName =
              replyInfo.from_display_name ||
              replyInfo.from_username ||
              `${replyUser.firstName || ""} ${replyUser.lastName || ""}`.trim() ||
              replyUser.username ||
              "用户";
            const replyContent = replyInfo.text || "";

            if (forwardStyle === "style1") {
              const ctaLine = `↳ @${replyName}: ${replyContent || "回复消息"}`;
              contentForRule = [ctaLine, contentForRule].filter(Boolean).join("\n");
            } else {
              useEmbed = false;
              extraEmbeds = [
                {
                  color: 0x0000ff,
                  description: `**💬 回复 ${replyName}**\n${replyContent}`,
                  footer: { text: `⏰ ${formatTimestampFromSeconds(params.date)}` }
                }
              ];
            }
          }

          // 处理附件
          const uploads: Array<{
            url?: string;
            localPath?: string;
            filename: string;
            isImage?: boolean;
            isVideo?: boolean;
          }> = [];
          const seenUploads = new Set<string>();
          const pushUpload = (entry: {
            url?: string;
            localPath?: string;
            filename: string;
            isImage?: boolean;
            isVideo?: boolean;
          }) => {
            const key = entry.localPath || entry.url;
            if (!key || seenUploads.has(key)) return;
            seenUploads.add(key);
            uploads.push(entry);
          };

          if (params.photo) {
            pushUpload({ url: params.photo, filename: "photo.jpg", isImage: true });
          }
          if (params.video) {
            pushUpload({ url: params.video, filename: "video.mp4", isVideo: true });
          }
          if (params.document) {
            pushUpload({ url: params.document, filename: "document" });
          }
          for (const media of mediaItems) {
            if (!media) continue;
            const localPath = typeof media.localPath === "string" ? media.localPath : undefined;
            const url = typeof media.url === "string" ? media.url : undefined;
            if (!localPath && !url) continue;
            const mimeType = typeof media.mimeType === "string" ? media.mimeType : "";
            const isImage = media.type === "photo" || mimeType.startsWith("image/");
            const isVideo = media.type === "video" || mimeType.startsWith("video/");
            const filename =
              (typeof media.fileName === "string" && media.fileName.trim()) ||
              (typeof media.filename === "string" && media.filename.trim()) ||
              (isImage ? "photo.jpg" : isVideo ? "video.mp4" : "file");
            pushUpload({ localPath, url, filename, isImage, isVideo });
          }

          // 发送消息
          await tempSender.sendData([{
            content: contentForRule,
            username: showSourceIdentity ? senderDisplayName : undefined,
            avatarUrl,
            uploads: uploads.length > 0 ? uploads : undefined,
            useEmbed,
            extraEmbeds,
          }]);

          console.log(`[Main] Forwarded Telegram message to Discord (rule: ${rule.sourceChannelId} -> ${rule.targetChannelId})`);
        } catch (error: any) {
          console.error(`[Main] Failed to forward Telegram message:`, error.message);
        }
      }
    }
  });

  telegramBridgeClient.on("error", (error) => {
    console.error("[Main] Telegram Bridge IPC error:", error);
  });

  telegramBridgeClient.on("exit", (code) => {
    console.log(`[Main] Telegram Bridge exited with code ${code}`);
    telegramBridgeClient = null;
  });
}

async function startAccount(account: AccountConfig, logger: FileLogger) {
  if (!account.loginRequested) {
    await writeStatus(account.id, "idle", "未请求登录");
    return;
  }

  // 立即设置 pending 状态，表示正在登录
  await writeStatus(account.id, "pending", "正在登录...");

  if (!account.token) {
    // 这个错误应该在 reconcileAccounts 中已经处理过了，这里只更新状态
    if (!loggedNoTokenAccounts.has(account.id)) {
      await logger.error(`账号 "${account.name}" 未配置 token，已跳过登录`);
      loggedNoTokenAccounts.add(account.id);
    }
    await writeStatus(account.id, "error", "未配置 Token");
    return;
  }

  // 检查是否有配置转发规则（Discord、飞书或 Telegram 至少一个）
  const webhooks = account.enableDiscordForward !== false ? (account.channelWebhooks || {}) : {};
  const feishuWebhooks = account.enableFeishuForward ? (account.channelFeishuWebhooks || {}) : {};
  const telegramMappings = account.telegramConfig?.mappings || [];
  const hasTelegramForward = telegramMappings.length > 0 && account.telegramConfig?.enableTelegramForward !== false;

  if (Object.keys(webhooks).length === 0 && Object.keys(feishuWebhooks).length === 0 && !hasTelegramForward) {
    await logger.error(`账号 "${account.name}" 未配置任何转发规则（Discord、飞书或 Telegram），无法启动`);
    await writeStatus(account.id, "error", "未配置转发规则");
    return;
  }

  // 首先检查是否已经存在运行中的账号
  const existing = runningAccounts.get(account.id);
  if (existing) {
    const isAlreadyLoggedIn = existing.client && (existing.client as any).user;
    const isLoggingIn =
      existing.isLoggingIn ||
      (existing.client && (existing.client as any).ws && (existing.client as any).ws.readyState === 0);
    
    // 如果账号已经登录或正在登录中，只更新配置，不重新创建
    if (isAlreadyLoggedIn || isLoggingIn) {
      await logger.info(`账号 "${account.name}" 已经运行${isAlreadyLoggedIn ? "且已登录" : "且正在登录中"}，跳过重复启动，仅更新配置`);
      
      // 更新配置
      const { senderBotsBySource, defaultSenderBot, feishuSendersBySource } = await buildSenderBots(account, logger);
      const legacyConfig = accountToLegacyConfig(account);
      existing.account = account;
      existing.senderBotsBySource = senderBotsBySource;
      (existing as any).feishuSendersBySource = feishuSendersBySource;
      existing.defaultSenderBot = defaultSenderBot;
      existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);
      
      if (isAlreadyLoggedIn) {
        await writeStatus(
          account.id,
          "online",
          buildDiscordLoginMessage((existing.client as any)?.user, "登录成功"),
        );
      }
      return;
    }
    
    // 如果账号存在但没有登录，先停止它
    await logger.info(`账号 "${account.name}" 存在但未登录，先停止旧实例`);
    await stopAccount(account.id, logger, false);
  }

  try {
    const { senderBotsBySource, defaultSenderBot, feishuSendersBySource } = await buildSenderBots(account, logger);
    const legacyConfig = accountToLegacyConfig(account);

    let client: Client;
    if (account.type === "bot") {
      client = new BotClient({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel, Partials.Message, Partials.User],
      }) as any;
    } else {
      // User Token (Selfbot) 配置
      // 注意：User Token 需要缓存自身信息和一定的上下文才能完成握手
      // 不能将 UserManager 或 GuildMemberManager 设为 0，否则无法触发 ready 事件
      try {
        // 使用宽松的配置，确保 Selfbot 能正常登录
        client = new SelfBotClient({
          checkUpdate: false,  // 禁用检查更新，加快启动
          patchVoice: false,   // 如果不用语音，禁用此项
          syncStatus: false,   // 不同步状态，减少数据包
          // 注意：暂时移除 makeCache 配置，因为过度限制会导致无法登录
          // 如果确实需要限制内存，可以稍后使用更宽松的配置
        } as any);
      } catch (e) {
        // 如果配置失败，使用最简配置
        client = new SelfBotClient({
          checkUpdate: false,
          patchVoice: false,
        } as any);
        logger.warn(`无法应用 Selfbot 配置，使用默认配置: ${String(e)}`);
      }
    }

    const bot = new Bot(client, legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);

    const runningInfo: RunningAccount = {
      account,
      client,
      bot,
      senderBotsBySource,
      defaultSenderBot,
      feishuSendersBySource,
      isManuallyStopped: false,
      reconnectCount: 0,
      lastReconnectTime: 0,
    isLoggingIn: true,
    };
    runningAccounts.set(account.id, runningInfo);

    // 添加调试日志，查看底层 WebSocket 状态（仅对 User Token）
    if (account.type === "selfbot") {
      (client as any).on("debug", (info: string) => {
        // 过滤掉心跳包日志，只看关键信息
        if (!info.includes("Heartbeat") && !info.includes("heartbeat")) {
          logger.debug(`[DEBUG ${account.name}] ${info}`);
        }
      });
    }

    // 在 ready 事件中注册重连处理器，避免登录过程中的临时断开事件触发重连
    // 先注册 ready 事件，在 ready 后再注册 disconnect 监听器
    // 同时监听 ready 和 clientReady 以兼容不同版本
    let readyHandled = false; // 防止重复处理
    const readyHandler = async () => {
      // 如果已经处理过，跳过
      if (readyHandled) {
        return;
      }
      
      const currentRunning = runningAccounts.get(account.id);
      if (currentRunning && currentRunning.isLoggingIn) {
        readyHandled = true;
        // 登录成功后，清除登录标志
        currentRunning.isLoggingIn = false;
        // 清除登录超时定时器
        if (currentRunning.loginTimeout) {
          clearTimeout(currentRunning.loginTimeout);
          currentRunning.loginTimeout = undefined;
        }
        // 现在才注册重连处理器，避免登录过程中的临时断开事件
        setupReconnectHandlers(account.id, logger);
        await writeStatus(
          account.id,
          "online",
          buildDiscordLoginMessage((bot.client as any)?.user, "登录成功"),
        );
        await logger.info(`账号 "${account.name}" 登录成功（通过 ready 事件），已注册重连处理器`);
      }
    };
    (bot.client as any).once("clientReady", readyHandler);
    (bot.client as any).once("ready", readyHandler);

    // 设置登录超时检查（30秒）
    runningInfo.loginTimeout = setTimeout(() => {
      const currentRunning = runningAccounts.get(account.id);
      if (currentRunning && currentRunning.isLoggingIn) {
        logger.warn(`账号 "${account.name}" 登录超时 (30秒)，可能是网络问题或账号被风控`);
        writeStatus(account.id, "error", "登录超时，可能是网络问题或需要登录").catch(() => {});
      }
    }, 30000);

    try {
      await logger.info(`账号 "${account.name}" 开始登录...`);
      await (bot.client as any).login(account.token);
      
      // 登录调用完成后，检查是否已经登录成功（ready 事件可能已经触发）
      // 等待一小段时间让 ready 事件有机会触发
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // 检查 client.user 是否存在，如果存在说明已经登录成功
      const client = bot.client as any;
      if (client.user && client.ws && client.ws.readyState === 1) {
        // 已经登录成功，直接更新状态
        const currentRunning = runningAccounts.get(account.id);
        if (currentRunning && currentRunning.isLoggingIn) {
          currentRunning.isLoggingIn = false;
          if (currentRunning.loginTimeout) {
            clearTimeout(currentRunning.loginTimeout);
            currentRunning.loginTimeout = undefined;
          }
          setupReconnectHandlers(account.id, logger);
          await writeStatus(
            account.id,
            "online",
            buildDiscordLoginMessage((bot.client as any)?.user, "登录成功"),
          );
          await logger.info(`账号 "${account.name}" 登录成功（通过状态检查），已注册重连处理器`);
          // 标记 ready 已处理，防止 readyHandler 重复处理
          readyHandled = true;
        }
      }
      // 注意：如果 ready 事件稍后触发，readyHandler 会检查 readyHandled 标志，不会重复操作
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.error(e);
      await logger.error(`账号 "${account.name}" 登录失败: ${msg}`);
      const isTokenInvalid = msg.includes("TOKEN_INVALID") || 
                            msg.includes("TokenInvalid") || 
                            msg.includes("Token 无效") ||
                            (e?.code === "TokenInvalid");
      
      await writeStatus(account.id, "error", isTokenInvalid ? "Token 无效" : msg);
      runningInfo.isLoggingIn = false;
      // 清除登录超时定时器
      if (runningInfo.loginTimeout) {
        clearTimeout(runningInfo.loginTimeout);
        runningInfo.loginTimeout = undefined;
      }
      // 如果不是 Token 无效的错误，尝试重连
      if (!isTokenInvalid) {
        await reconnectAccount(account.id, logger, 5000);
      } else {
        await logger.error(`账号 "${account.name}" Token 无效，停止登录`);
        await stopAccount(account.id, logger, false);
      }
    }
  } catch (e: any) {
    await logger.error(`启动账号 "${account.name}" 失败: ${String(e?.message || e)}`);
    await writeStatus(account.id, "error", String(e?.message || e));
  }
}

async function stopAccount(accountId: string, logger: FileLogger, manual: boolean = true) {
  const running = runningAccounts.get(accountId);
  if (!running) return;
  
  // 标记为手动停止
  if (manual) {
    running.isManuallyStopped = true;
  }
  running.isLoggingIn = false;
  
  // 清除重连定时器
  if (running.reconnectTimer) {
    clearTimeout(running.reconnectTimer);
    running.reconnectTimer = undefined;
  }
  
  try {
    // 清理 Bot 资源（包括定时器等）
    if (running.bot && typeof (running.bot as any).cleanup === "function") {
      await (running.bot as any).cleanup();
    }
    if ((running.client as any).destroy) {
      await (running.client as any).destroy();
    }
  } catch (e: any) {
    await logger.error(`停止账号 "${running.account.name}" 时销毁客户端失败: ${String(e?.message || e)}`);
  }
  runningAccounts.delete(accountId);
  await logger.info(`账号 "${running.account.name}" 已停止`);
  await writeStatus(accountId, "stopped", "已停止");
}

// 自动重连函数
async function reconnectAccount(accountId: string, logger: FileLogger, delay: number = 5000) {
  const running = runningAccounts.get(accountId);
  if (!running) return;
  
  // 如果手动停止，不重连
  if (running.isManuallyStopped) {
    return;
  }
  
  // 如果已经有重连定时器在运行，不重复创建
  if (running.reconnectTimer) {
    return;
  }
  
  // 检查是否已经连接成功（避免重复重连）
  const client = running.client as any;
  // 更严格的检查：确保 client.user 存在（表示已登录），且 WebSocket 状态为 OPEN (1)
  if (client && client.user && client.ws) {
    const wsState = client.ws.readyState;
    // WebSocket 状态：0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
    if (wsState === 1) {
      await logger.info(`账号 "${running.account.name}" 已经连接（readyState=${wsState}），跳过重连`);
      await writeStatus(
        accountId,
        "online",
        buildDiscordLoginMessage((client as any)?.user, "已连接"),
      );
      // 清除可能存在的重连定时器
      if (running.reconnectTimer) {
        clearTimeout(running.reconnectTimer);
        running.reconnectTimer = undefined;
      }
      return;
    } else {
      await logger.debug(`账号 "${running.account.name}" WebSocket 状态: ${wsState} (0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED)`);
    }
  }
  
  // 限制重连次数：如果 5 分钟内重连超过 10 次，停止重连
  const now = Date.now();
  if (now - running.lastReconnectTime > 5 * 60 * 1000) {
    // 超过 5 分钟，重置计数
    running.reconnectCount = 0;
  }
  if (running.reconnectCount >= 10) {
    await logger.error(`账号 "${running.account.name}" 重连次数过多（${running.reconnectCount}次），停止自动重连`);
    await writeStatus(accountId, "error", "重连次数过多，请检查网络或 Token");
    await stopAccount(accountId, logger, false);
    return;
  }
  
  // 如果账号不再请求登录，不重连
  const currentConfig = await getMultiConfig();
  const account = currentConfig.accounts.find(a => a.id === accountId);
  if (!account || !account.loginRequested) {
    await stopAccount(accountId, logger, false);
    return;
  }
  
  running.reconnectCount++;
  running.lastReconnectTime = now;
  await logger.info(`账号 "${running.account.name}" 将在 ${delay / 1000} 秒后尝试重连... (第 ${running.reconnectCount} 次)`);
  await writeStatus(accountId, "pending", `连接断开，${delay / 1000} 秒后重连... (${running.reconnectCount}/10)`);
  
  running.reconnectTimer = setTimeout(async () => {
    // 清除定时器引用
    const currentRunning = runningAccounts.get(accountId);
    if (!currentRunning) {
      return;
    }
      currentRunning.reconnectTimer = undefined;
    if (currentRunning.isManuallyStopped) {
      return;
    }
    try {
      // 清理旧的客户端
      try {
        if ((currentRunning.client as any).destroy) {
          await (currentRunning.client as any).destroy();
        }
      } catch {}
      
      // 重新创建客户端
      let client: Client;
      if (currentRunning.account.type === "bot") {
        client = new BotClient({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel, Partials.Message, Partials.User],
        }) as any;
      } else {
        // User Token (Selfbot) 配置 - 重连时使用相同配置
        try {
          client = new SelfBotClient({
            checkUpdate: false,
            patchVoice: false,
            syncStatus: false,  // 不同步状态，减少数据包
            // 注意：暂时移除 makeCache 配置，确保能正常登录
          } as any);
        } catch (e) {
          client = new SelfBotClient({
            checkUpdate: false,
            patchVoice: false,
          } as any);
        }
      }
      
      // 重新创建 Bot 实例
      const legacyConfig = accountToLegacyConfig(currentRunning.account);
      const bot = new Bot(client, legacyConfig, currentRunning.defaultSenderBot, currentRunning.senderBotsBySource);
      
      // 更新运行信息
      currentRunning.client = client;
      currentRunning.bot = bot;
      currentRunning.isLoggingIn = true;
      
      // 添加调试日志（仅对 User Token）
      if (currentRunning.account.type === "selfbot") {
        (client as any).on("debug", (info: string) => {
          if (!info.includes("Heartbeat") && !info.includes("heartbeat")) {
            logger.debug(`[DEBUG ${currentRunning.account.name}] ${info}`);
          }
        });
      }

      // 在 ready 事件中注册重连处理器，避免重连过程中的临时断开事件
      // 同时监听 ready 和 clientReady 以兼容不同版本
      const readyHandler = async () => {
        const currentRunningAfterReady = runningAccounts.get(accountId);
        if (currentRunningAfterReady) {
          // 重连成功后，清除登录标志
          currentRunningAfterReady.isLoggingIn = false;
          // 清除登录超时定时器
          if (currentRunningAfterReady.loginTimeout) {
            clearTimeout(currentRunningAfterReady.loginTimeout);
            currentRunningAfterReady.loginTimeout = undefined;
          }
          // 现在才注册重连处理器
          setupReconnectHandlers(accountId, logger);
          await writeStatus(
            accountId,
            "online",
            buildDiscordLoginMessage((currentRunningAfterReady.client as any)?.user, "重连成功"),
          );
          // 重连成功，重置计数
          currentRunningAfterReady.reconnectCount = 0;
          await logger.info(`账号 "${currentRunningAfterReady.account.name}" 重连成功，已注册重连处理器`);
        }
      };
      (client as any).once("clientReady", readyHandler);
      (client as any).once("ready", readyHandler);

      // 设置重连登录超时检查（30秒）
      currentRunning.loginTimeout = setTimeout(() => {
        const timeoutRunning = runningAccounts.get(accountId);
        if (timeoutRunning && timeoutRunning.isLoggingIn) {
          logger.warn(`账号 "${timeoutRunning.account.name}" 重连登录超时 (30秒)，可能是网络问题或账号被风控`);
          writeStatus(accountId, "error", "重连登录超时，可能是网络问题或需要登录").catch(() => {});
        }
      }, 30000);
      
      // 尝试登录
      try {
        await (client as any).login(currentRunning.account.token);
        // 注意：状态更新和 isLoggingIn 清除现在在 ready 事件中处理
      } catch (e: any) {
        const msg = String(e?.message || e);
        await logger.error(`账号 "${currentRunning.account.name}" 重连失败: ${msg}`);
        await writeStatus(accountId, "error", `重连失败: ${msg}`);
        currentRunning.isLoggingIn = false;
        // 清除登录超时定时器
        if (currentRunning.loginTimeout) {
          clearTimeout(currentRunning.loginTimeout);
          currentRunning.loginTimeout = undefined;
        }
        
        // 检查是否是Token无效的错误，如果是则不重连
        const isTokenInvalid = msg.includes("TOKEN_INVALID") || 
                              msg.includes("TokenInvalid") || 
                              msg.includes("Token 无效") ||
                              (e?.code === "TokenInvalid");
        
        if (isTokenInvalid) {
          await logger.error(`账号 "${currentRunning.account.name}" Token 无效，停止重连`);
          await writeStatus(accountId, "error", "Token 无效，请检查 Token 配置");
          await stopAccount(accountId, logger, false);
          return;
        }
        
        // 检查是否应该继续重连
        const shouldRetry = currentRunning && 
                           !currentRunning.isManuallyStopped && 
                           currentRunning.reconnectCount < 10;
        
        if (shouldRetry) {
        // 如果重连失败，再次尝试（指数退避，最多30秒）
        const nextDelay = Math.min(delay * 2, 30000);
        await reconnectAccount(accountId, logger, nextDelay);
        } else {
          await logger.error(`账号 "${currentRunning.account.name}" 停止重连（已达到最大次数或已手动停止）`);
          await stopAccount(accountId, logger, false);
        }
      }
    } catch (e: any) {
      const currentRunning = runningAccounts.get(accountId);
      if (!currentRunning) return;
      
      await logger.error(`账号 "${currentRunning.account.name}" 重连过程出错: ${String(e?.message || e)}`);
      
      // 检查是否应该继续重连
      const shouldRetry = !currentRunning.isManuallyStopped && 
                         currentRunning.reconnectCount < 10;
      
      if (shouldRetry) {
      const nextDelay = Math.min(delay * 2, 30000);
      await reconnectAccount(accountId, logger, nextDelay);
      } else {
        await logger.error(`账号 "${currentRunning.account.name}" 停止重连（已达到最大次数或已手动停止）`);
        await stopAccount(accountId, logger, false);
      }
    }
  }, delay);
}

// 设置重连处理器
function setupReconnectHandlers(accountId: string, logger: FileLogger) {
  const running = runningAccounts.get(accountId);
  if (!running) return;
  
  const client = running.client;
  
  // 移除旧的事件监听器（如果存在），避免重复添加
  // 使用 accountId 而不是闭包捕获 running，确保总是获取最新的 running 对象
  const disconnectHandler = async () => {
    const currentRunning = runningAccounts.get(accountId);
    if (!currentRunning || currentRunning.isManuallyStopped) return;
    
    // 检查是否正在登录中，如果是则忽略断开事件（登录过程中可能有临时断开）
    if (currentRunning.isLoggingIn) {
      await logger.debug(`账号 "${currentRunning.account.name}" 登录中，忽略断开事件`);
      return;
    }
    
    // 再次检查连接状态，可能已经自动恢复了
    const client = currentRunning.client as any;
    if (client && client.user && client.ws && client.ws.readyState === 1) {
      await logger.debug(`账号 "${currentRunning.account.name}" 断开事件触发但连接已恢复，跳过重连`);
      return;
    }
    
    await logger.warn(`账号 "${currentRunning.account.name}" 连接断开`);
    await writeStatus(accountId, "error", "连接断开，正在重连...");
    await reconnectAccount(accountId, logger, 5000);
  };
  
  const shardDisconnectHandler = async () => {
    const currentRunning = runningAccounts.get(accountId);
    if (!currentRunning || currentRunning.isManuallyStopped) return;
    
    // 检查是否正在登录中，如果是则忽略断开事件
    if (currentRunning.isLoggingIn) {
      await logger.debug(`账号 "${currentRunning.account.name}" 登录中，忽略 shard 断开事件`);
      return;
    }
    
    // 再次检查连接状态
    const client = currentRunning.client as any;
    if (client && client.user && client.ws && client.ws.readyState === 1) {
      await logger.debug(`账号 "${currentRunning.account.name}" shard 断开事件触发但连接已恢复，跳过重连`);
      return;
    }
    
    await logger.warn(`账号 "${currentRunning.account.name}" shard 断开`);
    await reconnectAccount(accountId, logger, 5000);
  };
  
  // 移除旧监听器（如果存在）
  (client as any).removeAllListeners("disconnect");
  (client as any).removeAllListeners("shardDisconnect");
  (client as any).removeAllListeners("resume");
  
  // 添加新的事件监听器
  (client as any).on("disconnect", disconnectHandler);
  (client as any).on?.("shardDisconnect", shardDisconnectHandler);
  
  // 监听 resume 事件（重连成功）
  (client as any).on("resume", async () => {
    const currentRunning = runningAccounts.get(accountId);
    if (currentRunning) {
      await logger.info(`账号 "${currentRunning.account.name}" 连接已恢复`);
      await writeStatus(
        accountId,
        "online",
        buildDiscordLoginMessage((currentRunning.client as any)?.user, "连接已恢复"),
      );
    }
  });
}

async function reconcileAccounts(newConfig: MultiConfig, logger: FileLogger) {
  const oldIds = new Set(runningAccounts.keys());
  const newIds = new Set(newConfig.accounts.map((a) => a.id));

  // 停掉被移除的账号（配置变化导致的停止，不是手动停止）
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      await stopAccount(id, logger, false); // 配置变化导致的停止
    }
  }

  // 新增或更新账号
  for (const account of newConfig.accounts) {
    // 如果账号请求登录但没有 token，跳过处理避免重复错误日志
    if (account.loginRequested && !account.token) {
      const existing = runningAccounts.get(account.id);
      if (!existing && !loggedNoTokenAccounts.has(account.id)) {
        // 只记录一次错误，避免重复日志
        await logger.error(`账号 "${account.name}" 未配置 token，已跳过登录`);
        await writeStatus(account.id, "error", "未配置 Token");
        loggedNoTokenAccounts.add(account.id);
      } else if (existing) {
        // 如果账号之前有 token 但现在没有了，需要停止（配置变化导致的停止）
        await stopAccount(account.id, logger, false);
        loggedNoTokenAccounts.add(account.id);
      }
      continue;
    }
    
    // 如果账号有 token 了，从错误记录中移除
    if (account.token && loggedNoTokenAccounts.has(account.id)) {
      loggedNoTokenAccounts.delete(account.id);
    }
    
    const existing = runningAccounts.get(account.id);
    if (!existing) {
      // 新账号，直接启动
      await startAccount(account, logger);
      continue;
    }

    const tokenChanged = account.token !== existing.account.token;
    const typeChanged = account.type !== existing.account.type;
    const oldAccount =
      currentConfig?.accounts.find((a) => a.id === account.id) || existing.account;

    // 检测转发类型变化（discord-to-discord, discord-to-telegram, telegram-to-discord, discord-to-feishu）
    const forwardingTypeChanged = account.forwardingType !== oldAccount.forwardingType;

    const mappingsChanged =
      JSON.stringify(account.channelWebhooks || {}) !== JSON.stringify(oldAccount.channelWebhooks || {}) ||
      JSON.stringify(account.replacementsDictionary || {}) !==
        JSON.stringify(oldAccount.replacementsDictionary || {});
    const ruleConfigChanged =
      JSON.stringify(account.mappings || []) !== JSON.stringify(oldAccount.mappings || []) ||
      JSON.stringify(account.telegramConfig?.mappings || []) !== JSON.stringify(oldAccount.telegramConfig?.mappings || []) ||
      JSON.stringify(account.feishuRuleConfigs || {}) !== JSON.stringify(oldAccount.feishuRuleConfigs || {});
    const relayChanged =
      JSON.stringify(account.botRelays || []) !== JSON.stringify(oldAccount.botRelays || []) ||
      JSON.stringify(account.channelRelayMap || {}) !== JSON.stringify(oldAccount.channelRelayMap || {});
    // 检测翻译配置变化
    const translationChanged =
      account.enableTranslation !== oldAccount.enableTranslation ||
      account.deepseekApiKey !== oldAccount.deepseekApiKey;
    const keywordsChanged =
      JSON.stringify(account.blockedKeywords || []) !== JSON.stringify(oldAccount.blockedKeywords || []) ||
      JSON.stringify(account.excludeKeywords || []) !== JSON.stringify(oldAccount.excludeKeywords || []) ||
      account.showSourceIdentity !== oldAccount.showSourceIdentity;
    const ignoreSettingsChanged =
      account.ignoreSelf !== oldAccount.ignoreSelf ||
      account.ignoreBot !== oldAccount.ignoreBot ||
      account.ignoreImages !== oldAccount.ignoreImages ||
      account.ignoreAudio !== oldAccount.ignoreAudio ||
      account.ignoreVideo !== oldAccount.ignoreVideo ||
      account.ignoreDocuments !== oldAccount.ignoreDocuments;
    // 检测用户过滤配置变化
    const userFilterChanged =
      JSON.stringify(account.allowedUsersIds || []) !== JSON.stringify(oldAccount.allowedUsersIds || []) ||
      JSON.stringify(account.mutedUsersIds || []) !== JSON.stringify(oldAccount.mutedUsersIds || []);
    const restartRequested = account.restartNonce !== oldAccount.restartNonce;
    // loginRequested 从 false 变为 true 时才认为是登录请求变化
    // loginNonce 的变化不应该触发重启（它只是用于触发登录，不应该在已登录时触发重启）
    const loginRequestedChanged = account.loginRequested !== oldAccount.loginRequested;
    const loginRequestedBecameTrue = !oldAccount.loginRequested && account.loginRequested;

    // 如果账号已经在运行且登录成功，检查是否需要重启
    const isAlreadyLoggedIn = existing.client && (existing.client as any).user;
    
    // 如果账号已经登录，且没有需要重启的变化，尝试热更新
    if (isAlreadyLoggedIn && 
        !tokenChanged && 
        !typeChanged && 
        !restartRequested &&
        !loginRequestedBecameTrue) {
      // 如果是停止请求（loginRequested 从 true 变为 false），需要停止账号（手动停止）
      if (loginRequestedChanged && account.loginRequested === false && existing.account.loginRequested === true) {
        await stopAccount(account.id, logger, true); // 手动停止
        continue;
      }

      // 如果有配置变化，进行热更新（不重启）
      if (
        mappingsChanged ||
        ruleConfigChanged ||
        translationChanged ||
        keywordsChanged ||
        ignoreSettingsChanged ||
        userFilterChanged ||
        relayChanged ||
        forwardingTypeChanged
      ) {
        let senderBotsBySource = existing.senderBotsBySource;
        let defaultSenderBot = existing.defaultSenderBot;
        let feishuSendersBySource = (existing as any).feishuSendersBySource;
        // 如果映射或翻译配置变化，需要重新构建 SenderBot
        if (mappingsChanged || translationChanged || relayChanged) {
          try {
            const built = await buildSenderBots(account, logger);
            senderBotsBySource = built.senderBotsBySource;
            defaultSenderBot = built.defaultSenderBot;
            feishuSendersBySource = built.feishuSendersBySource;
          } catch (e: any) {
            await logger.error(`账号 "${account.name}" 重新构建 SenderBot 失败: ${String(e?.message || e)}`);
            await writeStatus(account.id, "error", `配置错误: ${String(e?.message || e)}`);
            continue; // 跳过这个账号，不更新配置
          }
        }

        const legacyConfig = accountToLegacyConfig(account);
        existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);
        existing.account = account;
        existing.senderBotsBySource = senderBotsBySource;
        existing.defaultSenderBot = defaultSenderBot;
        (existing as any).feishuSendersBySource = feishuSendersBySource;

        // 如果转发类型变化，记录日志
        if (forwardingTypeChanged) {
          await logger.info(`账号 "${account.name}" 转发类型已从 "${oldAccount.forwardingType || 'discord-to-discord'}" 切换为 "${account.forwardingType || 'discord-to-discord'}"`);
        }

        await logger.info(`账号 "${account.name}" 配置已热更新（无需重启）`);
        continue;
      }

      // 其他情况（包括只是 loginNonce 变化），跳过处理
      continue;
    }

    // 如果账号未请求登录，且当前正在运行，需要停止（手动停止）
    if (!account.loginRequested && isAlreadyLoggedIn) {
      await stopAccount(account.id, logger, true); // 手动停止
      continue;
    }

    // 没有任何变化则跳过
    if (
      !typeChanged &&
      !tokenChanged &&
      !mappingsChanged &&
      !ruleConfigChanged &&
      !translationChanged &&
      !keywordsChanged &&
      !ignoreSettingsChanged &&
      !userFilterChanged &&
      !relayChanged &&
      !restartRequested &&
      !loginRequestedBecameTrue &&
      !forwardingTypeChanged
    ) {
      continue;
    }

    // 只有在真正需要重启时才重启（配置变化导致的停止，不是手动停止）
    // loginRequestedBecameTrue 表示从 false 变为 true，需要启动账号
    if (typeChanged || tokenChanged || restartRequested || loginRequestedBecameTrue) {
      await stopAccount(account.id, logger, false); // 配置变化导致的停止
      await startAccount(account, logger);
      continue;
    }

    let senderBotsBySource = existing.senderBotsBySource;
    let defaultSenderBot = existing.defaultSenderBot;
    let feishuSendersBySource = (existing as any).feishuSendersBySource;
    // 如果映射或翻译配置变化，需要重新构建 SenderBot
    if (mappingsChanged || translationChanged || relayChanged) {
      try {
      const built = await buildSenderBots(account, logger);
      senderBotsBySource = built.senderBotsBySource;
      defaultSenderBot = built.defaultSenderBot;
        feishuSendersBySource = built.feishuSendersBySource;
      } catch (e: any) {
        await logger.error(`账号 "${account.name}" 重新构建 SenderBot 失败: ${String(e?.message || e)}`);
        await writeStatus(account.id, "error", `配置错误: ${String(e?.message || e)}`);
        continue; // 跳过这个账号，不更新配置
      }
    }

    const legacyConfig = accountToLegacyConfig(account);
    existing.bot.updateRuntimeConfig(legacyConfig, defaultSenderBot, senderBotsBySource, feishuSendersBySource);
    existing.account = account;
    existing.senderBotsBySource = senderBotsBySource;
    existing.defaultSenderBot = defaultSenderBot;
    (existing as any).feishuSendersBySource = feishuSendersBySource;

    if (keywordsChanged || ignoreSettingsChanged || mappingsChanged || ruleConfigChanged || translationChanged) {
      await logger.info(`账号 "${account.name}" 配置已热更新`);
    }
  }

  // 同步配置到Telegram Bridge
  try {
    await syncConfigToTelegramBridge(newConfig);
  } catch (error: any) {
    await logger.error(`同步配置到Telegram Bridge失败: ${error.message}`);
  }

  currentConfig = newConfig;
}

async function main() {
  const logger = new FileLogger();
  
  // 在启动时先确保文件存在。这是唯一一次允许创建默认文件的机会。
  // 之后的热重载只负责读取，不会创建文件，避免在原子保存间隙时覆盖配置
  await ensureConfigFile();
  
  const multi = await getMultiConfig();
  currentConfig = multi;

  // --- 启动时强制重置登录状态，防止自动登录 ---
  let needSaveConfig = false;
  for (const account of multi.accounts) {
    if (account.loginRequested) {
      account.loginRequested = false;
      needSaveConfig = true;
      await logger.info(`账号 "${account.name}" 登录状态已重置，需要手动点击登录`);
    }
  }
  // 如果有账号被重置，保存配置
  if (needSaveConfig) {
    const { saveMultiConfig } = await import("./config.js");
    await saveMultiConfig(multi);
    await logger.info("已重置所有账号的登录状态");
  }

  // 只启动已请求登录的账号，不自动登录
  for (const account of multi.accounts) {
    if (account.loginRequested && account.token) {
      await startAccount(account, logger);
    } else {
      // 确保未请求登录的账号状态正确
      await writeStatus(account.id, "idle", "未请求登录");
    }
  }

  // 启动Telegram Bridge进程
  try {
    console.log("[Main] Starting Telegram Bridge...");
    telegramBridgeManager.on("started", async () => {
      setupTelegramBridgeClient();
      if (currentConfig) {
        try {
          await syncConfigToTelegramBridge(currentConfig);
        } catch (error: any) {
          console.error(`[Main] Failed to sync config to Telegram Bridge: ${error?.message || error}`);
        }
      }
    });

    const bridgeResult = await telegramBridgeManager.start();
    if (bridgeResult.success) {
      console.log(`[Main] Telegram Bridge started successfully (PID: ${bridgeResult.pid})`);
    } else {
      console.error(`[Main] Failed to start Telegram Bridge: ${bridgeResult.message}`);
    }
  } catch (error: any) {
    console.error(`[Main] Error starting Telegram Bridge: ${error.message}`);
  }

  const cfgPath = path.resolve(process.cwd(), "config.json");
  let pendingReload: NodeJS.Timeout | null = null;
  let checking = false; // 防止并发检查

  // 检查配置文件是否真的变化了（异步版本，不阻塞事件循环）
  const hasConfigChanged = async (): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      stat(cfgPath, async (err, stats) => {
        if (err) {
          resolve(false);
          return;
        }
        
      // 如果修改时间相同，说明文件没有变化
      if (stats.mtimeMs === lastConfigMtime) {
          resolve(false);
          return;
      }
      
        try {
      // 读取文件内容并计算 hash
      const content = await fs.readFile(cfgPath, "utf-8");
      const hash = createHash("md5").update(content).digest("hex");
      
      // 如果 hash 相同，说明内容没有变化
      if (hash === lastConfigHash) {
        lastConfigMtime = stats.mtimeMs; // 更新修改时间，避免下次重复读取
            resolve(false);
            return;
      }
      
      // 文件内容变化了
      lastConfigHash = hash;
      lastConfigMtime = stats.mtimeMs;
          resolve(true);
    } catch (e) {
          // 读取失败，返回 false
          resolve(false);
    }
      });
    });
  };

  const scheduleReload = async () => {
    if (pendingReload || checking) return; // 防止并发
    checking = true;
    
    if (pendingReload) clearTimeout(pendingReload);
    pendingReload = setTimeout(async () => {
      pendingReload = null;
      try {
        // 检查是否有触发文件（API 直接触发的操作）
        const triggerPath = path.resolve(process.cwd(), ".data", "trigger_reload");
        let shouldReload = false;
        try {
          await fs.access(triggerPath);
          // 删除触发文件
          await fs.unlink(triggerPath);
          shouldReload = true;
        } catch {
          // 触发文件不存在，检查配置文件是否变化
          shouldReload = await hasConfigChanged();
        }
        
        if (!shouldReload) {
          return; // 没有变化，跳过处理
        }
        
        // 读取配置时可能遇到原子保存间隙（文件暂时不存在），需要重试
        let latest: MultiConfig | null = null;
        let retries = 3;
        while (retries > 0 && !latest) {
          try {
            latest = await getMultiConfig();
          } catch (e: any) {
            retries--;
            if (retries > 0) {
              // 可能是原子保存间隙，等待一小段时间后重试
              await new Promise(resolve => setTimeout(resolve, 100));
            } else {
              // 重试失败，记录错误但不中断程序
              console.error("读取配置文件失败（可能是原子保存间隙）", e);
              await logger.error(`读取配置文件失败: ${String(e?.message || e)}`);
              return; // 放弃本次重载，等待下次轮询
            }
          }
        }
        
        if (latest) {
          await reconcileAccounts(latest, logger);
        }
      } catch (e: any) {
        console.error("自动重载配置失败", e);
        await logger.error(`自动重载配置失败: ${String(e?.message || e)}`);
      } finally {
        checking = false; // 确保在所有情况下都重置标志
      }
    }, 100); // 缩短延迟到 100ms，更快响应
  };

  try {
    watch(cfgPath, { persistent: true }, scheduleReload);
    await logger.info(`已开始监听配置文件: ${cfgPath}`);
  } catch (e: any) {
    await logger.error(`无法监听配置文件: ${cfgPath}, 错误: ${String(e?.message || e)}`);
  }

  // 轮询兜底，每 2 秒检查一次触发文件（API 触发的操作）
  setInterval(() => {
    scheduleReload();
  }, 2000);
}

process.on("unhandledRejection", async (reason: any) => {
  const logger = new FileLogger();
  await logger.error(String(reason?.stack || reason));
});

process.on("uncaughtException", async (err: any) => {
  const logger = new FileLogger();
  await logger.error(String(err?.stack || err));
});

// 优雅关闭处理
process.on("SIGINT", async () => {
  console.log("[Main] Received SIGINT, shutting down...");
  await telegramBridgeManager.cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("[Main] Received SIGTERM, shutting down...");
  await telegramBridgeManager.cleanup();
  process.exit(0);
});

/**
 * 同步配置到Telegram Bridge进程
 */
async function syncConfigToTelegramBridge(config: MultiConfig) {
  // 检查Telegram Bridge是否在运行
  if (!telegramBridgeManager.isRunning()) {
    console.log("[ConfigSync] Telegram Bridge not running, skipping config sync");
    return;
  }

  // 提取Telegram相关配置
  const telegramAccounts: any[] = [];
  const telegramAccountIds = new Set<string>();
  const pushTelegramAccount = (tgAccount: any) => {
    if (!tgAccount || !tgAccount.id) return;
    if (telegramAccountIds.has(tgAccount.id)) return;
    telegramAccounts.push(tgAccount);
    telegramAccountIds.add(tgAccount.id);
  };
  const telegramMappings = [];

  for (const account of config.accounts) {
    if (account.telegramConfig) {
      // 添加Telegram账号
      if (account.telegramConfig.accounts) {
        for (const tgAccount of account.telegramConfig.accounts) {
          pushTelegramAccount({
            id: tgAccount.id,
            name: tgAccount.name,
            type: tgAccount.type,
            token: tgAccount.token,
            sessionPath: tgAccount.sessionPath,
            sessionString: tgAccount.sessionString,
            apiId: tgAccount.apiId,
            apiHash: tgAccount.apiHash,
            proxyUrl: tgAccount.proxyUrl,
            enabled: tgAccount.enabled === true
          });
        }
      }

      const hasExplicitClient = (account.telegramConfig.accounts || []).some(
        (tgAccount) => tgAccount.type === "client" || tgAccount.id === account.id,
      );
      const hasExplicitBot = (account.telegramConfig.accounts || []).some(
        (tgAccount) => tgAccount.type === "bot",
      );
      const hasLegacyClientConfig = Boolean(
        (account.telegramSessionPath || account.telegramSessionString) &&
        account.telegramApiId &&
        account.telegramApiHash,
      );
      const hasLegacyBotConfig = Boolean(account.telegramBotToken);

      // 如果有 legacy bot token 且没有显式的 bot 账号，创建一个 bot 账号
      if (!hasExplicitBot && hasLegacyBotConfig) {
        // 检查是否有对应的 bot 状态条目（用户可能手动断开过）
        const botStatusId = `${account.id}_bot`;
        const existingBotEntry = (account.telegramConfig.accounts || []).find(
          (tgAccount) => tgAccount.id === botStatusId
        );
        pushTelegramAccount({
          id: botStatusId,
          name: `${account.name || "Telegram"} Bot`,
          type: "bot",
          token: account.telegramBotToken,
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          proxyUrl: account.proxyUrl,
          // 优先使用已保存的 enabled 状态，否则默认 false
          enabled: existingBotEntry ? existingBotEntry.enabled === true : false,
        });
      }

      // 如果有 legacy client 配置（session）且没有显式的 client 账号，创建一个 client 账号
      if (!hasExplicitClient && hasLegacyClientConfig) {
        // 检查是否有对应的 client 状态条目（用户可能手动断开过）
        const existingClientEntry = (account.telegramConfig.accounts || []).find(
          (tgAccount) => tgAccount.id === account.id
        );
        pushTelegramAccount({
          id: account.id,
          name: account.name || "Telegram Client",
          type: "client",
          token: account.telegramApiHash || "",
          sessionPath: account.telegramSessionPath,
          sessionString: account.telegramSessionString,
          apiId: account.telegramApiId,
          apiHash: account.telegramApiHash,
          proxyUrl: account.proxyUrl,
          // 优先使用已保存的 enabled 状态，否则默认 false
          enabled: existingClientEntry ? existingClientEntry.enabled === true : false,
        });
      }

      // 添加Telegram映射，并附带 Discord 账号的 showSourceIdentity 设置
      if (account.telegramConfig.mappings) {
        for (const mapping of account.telegramConfig.mappings) {
          telegramMappings.push({
            ...mapping,
            showSourceIdentity: account.showSourceIdentity === true,
          });
        }
      }
    }
  }

  // 发送配置更新消息到Telegram Bridge
  const configUpdateMessage = {
    type: "request",
    id: `config_sync_${Date.now()}`,
    method: "updateConfig",
    params: {
      accounts: telegramAccounts,
      mappings: telegramMappings
    }
  };

  const messageSent = telegramBridgeManager.sendMessage(JSON.stringify(configUpdateMessage));
  if (messageSent) {
    console.log(`[ConfigSync] Configuration synced to Telegram Bridge (${telegramAccounts.length} accounts, ${telegramMappings.length} mappings)`);
  } else {
    console.error("[ConfigSync] Failed to send config update to Telegram Bridge");
  }
}

/**
 * 获取 Telegram Bridge 客户端
 */
export function getTelegramBridgeClient(): TelegramBridgeClient | null {
  return telegramBridgeClient;
}

main();
