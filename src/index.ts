import { Client as SelfBotClient } from "discord.js-selfbot-v13";
import { Client as BotClient, GatewayIntentBits, Partials } from "discord.js";
import { promises as fs } from "fs";
import { watch, stat } from "node:fs";
import path from "node:path";
import { createHash } from "crypto";

import { Bot, Client } from "./bot.js";
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

interface RunningAccount {
  account: AccountConfig;
  client: Client;
  bot: Bot;
  senderBotsBySource: Map<string, SenderBot>;
  defaultSenderBot: SenderBot;
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
// 记录已经输出过"未配置 token"错误的账号，避免重复日志
const loggedNoTokenAccounts = new Set<string>();
// 记录配置文件的 hash，只在真正变化时才重新读取
let lastConfigHash: string | null = null;
let lastConfigMtime: number = 0;

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

async function buildSenderBots(account: AccountConfig, logger: FileLogger) {
  const env = getEnv();
  const senderBotsBySource = new Map<string, SenderBot>();
  const feishuSendersBySource = new Map<string, FeishuSender>();
  let defaultSenderBot: SenderBot | undefined;
  const prepares: Promise<any>[] = [];

  const webhooks = account.channelWebhooks || {};
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
    for (const [channelId, chatId] of Object.entries(feishuWebhooks)) {
      if (!chatId) continue;
      const fs = new FeishuSender(
        chatId.trim(),
        httpAgent,
        account.feishuAppId,
        account.feishuAppSecret,
      );
      feishuSendersBySource.set(channelId, fs);
    }
  }

  if (!defaultSenderBot) {
    throw new Error("At least one webhook must be configured via channelWebhooks.");
  }

  await Promise.all(prepares);

  // 移除重复的 webhook 日志输出，只在日志文件中记录一次
  logger.info(`account "${account.name}" senderBots 构建完成，映射频道数=${senderBotsBySource.size}`);

  return { senderBotsBySource, defaultSenderBot: defaultSenderBot!, feishuSendersBySource };
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

  // 检查是否有配置 webhook，如果没有则提前返回
  const webhooks = account.channelWebhooks || {};
  if (Object.keys(webhooks).length === 0) {
    await logger.error(`账号 "${account.name}" 未配置 webhook，无法启动`);
    await writeStatus(account.id, "error", "未配置转发规则（channelWebhooks）");
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
        await writeStatus(account.id, "online", "登录成功");
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
        await writeStatus(account.id, "online", "登录成功");
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
          await writeStatus(account.id, "online", "登录成功");
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
      await writeStatus(accountId, "online", "已连接");
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
          await writeStatus(accountId, "online", "重连成功");
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
      await writeStatus(accountId, "online", "连接已恢复");
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

    const mappingsChanged =
      JSON.stringify(account.channelWebhooks || {}) !== JSON.stringify(oldAccount.channelWebhooks || {}) ||
      JSON.stringify(account.replacementsDictionary || {}) !==
        JSON.stringify(oldAccount.replacementsDictionary || {});
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
      if (mappingsChanged || translationChanged || keywordsChanged || userFilterChanged || relayChanged) {
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
    if (!typeChanged && !tokenChanged && !mappingsChanged && !translationChanged && !keywordsChanged && !userFilterChanged && !relayChanged && !restartRequested && !loginRequestedBecameTrue) {
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

    if (keywordsChanged || mappingsChanged || translationChanged) {
      await logger.info(`账号 "${account.name}" 配置已热更新`);
    }
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

  // 只启动已请求登录的账号，不自动登录
  for (const account of multi.accounts) {
    if (account.loginRequested && account.token) {
      await startAccount(account, logger);
    } else {
      // 确保未请求登录的账号状态正确
      await writeStatus(account.id, "idle", "未请求登录");
    }
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

main();
