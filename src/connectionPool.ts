/**
 * 全局连接池 - 解决同一账号在多个实例中重复登录的问题
 *
 * 核心逻辑：
 * - 使用凭据哈希作为 Key（而非 Account ID），确保相同凭据只登录一次
 * - 引用计数管理：当所有实例都释放连接时才真正断开
 * - 支持 Discord (Bot/Selfbot) 和 Telegram (Bot/Client) 两种类型
 */

import { Client as SelfBotClient } from "discord.js-selfbot-v13";
import { Client as BotClient, GatewayIntentBits, Partials } from "discord.js";
import { createHash } from "crypto";
import { ProxyAgent } from "proxy-agent";
import { getEnv } from "./env.js";
import { FileLogger } from "./logger.js";

// Discord Client 类型
export type DiscordClient = SelfBotClient | BotClient;

// 连接状态
export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

// Discord 连接信息
export interface DiscordConnection {
  type: "discord";
  clientType: "bot" | "selfbot";
  client: DiscordClient;
  status: ConnectionStatus;
  refCount: number;
  token: string;
  error?: string;
  user?: { id: string; username: string; discriminator?: string };
}

// Telegram 连接信息
export interface TelegramConnection {
  type: "telegram";
  clientType: "bot" | "client";
  status: ConnectionStatus;
  refCount: number;
  sessionKey: string; // bot token 或 session hash
  error?: string;
  user?: { id: string; username?: string; firstName?: string };
}

export type Connection = DiscordConnection | TelegramConnection;

// 连接池事件监听器
type ConnectionEventListener = (key: string, connection: Connection) => void;

/**
 * 生成 Discord 凭据的哈希 Key
 */
export function buildDiscordCredentialKey(token: string): string {
  return `discord:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

/**
 * 生成 Telegram 凭据的哈希 Key
 */
export function buildTelegramCredentialKey(
  type: "bot" | "client",
  credential: string // bot token 或 session string/path
): string {
  const hash = createHash("sha256").update(credential).digest("hex").slice(0, 16);
  return `telegram:${type}:${hash}`;
}

/**
 * 全局连接池管理器
 */
class ConnectionPoolManager {
  private connections = new Map<string, Connection>();
  private listeners: ConnectionEventListener[] = [];
  private logger: FileLogger | null = null;

  setLogger(logger: FileLogger) {
    this.logger = logger;
  }

  /**
   * 添加状态变化监听器
   */
  onStatusChange(listener: ConnectionEventListener) {
    this.listeners.push(listener);
  }

  /**
   * 通知所有监听器
   */
  private notifyListeners(key: string, connection: Connection) {
    for (const listener of this.listeners) {
      try {
        listener(key, connection);
      } catch (e) {
        // 忽略监听器错误
      }
    }
  }

  /**
   * 获取连接（如果存在）
   */
  getConnection(key: string): Connection | undefined {
    return this.connections.get(key);
  }

  /**
   * 获取所有连接
   */
  getAllConnections(): Map<string, Connection> {
    return new Map(this.connections);
  }

  /**
   * 检查连接是否存在且已连接
   */
  isConnected(key: string): boolean {
    const conn = this.connections.get(key);
    return conn?.status === "connected";
  }

  /**
   * 获取或创建 Discord 连接
   */
  async acquireDiscord(
    token: string,
    clientType: "bot" | "selfbot",
    proxyUrl?: string
  ): Promise<{ key: string; connection: DiscordConnection }> {
    const key = buildDiscordCredentialKey(token);
    const existing = this.connections.get(key) as DiscordConnection | undefined;

    // 如果已存在连接
    if (existing) {
      existing.refCount++;
      await this.logger?.info(`[ConnectionPool] Discord 连接已存在，引用计数: ${existing.refCount}`);
      return { key, connection: existing };
    }

    // 创建新连接
    const connection: DiscordConnection = {
      type: "discord",
      clientType,
      client: null as any,
      status: "connecting",
      refCount: 1,
      token,
    };
    this.connections.set(key, connection);
    this.notifyListeners(key, connection);

    try {
      const client = await this.createDiscordClient(clientType, token, proxyUrl);
      connection.client = client;
      connection.status = "connected";
      connection.user = {
        id: (client as any).user?.id || "",
        username: (client as any).user?.username || "",
        discriminator: (client as any).user?.discriminator,
      };
      await this.logger?.info(`[ConnectionPool] Discord 连接成功: ${connection.user.username}`);
      this.notifyListeners(key, connection);
    } catch (error: any) {
      connection.status = "error";
      connection.error = error.message || "连接失败";
      await this.logger?.error(`[ConnectionPool] Discord 连接失败: ${connection.error}`);
      this.notifyListeners(key, connection);
      throw error;
    }

    return { key, connection };
  }

  /**
   * 创建 Discord 客户端
   */
  private async createDiscordClient(
    clientType: "bot" | "selfbot",
    token: string,
    proxyUrl?: string
  ): Promise<DiscordClient> {
    const proxy = proxyUrl || getEnv().PROXY_URL;
    const agent = proxy ? new ProxyAgent(proxy) : undefined;

    if (clientType === "selfbot") {
      const client = new SelfBotClient({
        checkUpdate: false,
        ws: agent ? { agent } : undefined,
        http: agent ? { agent } : undefined,
      });
      await client.login(token);
      return client;
    } else {
      const client = new BotClient({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel, Partials.Message],
        rest: agent ? { agent } : undefined,
        ws: agent ? { agent } : undefined,
      });
      await client.login(token);
      return client;
    }
  }

  /**
   * 释放连接引用
   */
  async release(key: string): Promise<void> {
    const connection = this.connections.get(key);
    if (!connection) return;

    connection.refCount--;
    await this.logger?.info(`[ConnectionPool] 释放连接 ${key}，剩余引用: ${connection.refCount}`);

    if (connection.refCount <= 0) {
      await this.disconnect(key);
    }
  }

  /**
   * 强制断开连接
   */
  async disconnect(key: string): Promise<void> {
    const connection = this.connections.get(key);
    if (!connection) return;

    await this.logger?.info(`[ConnectionPool] 断开连接: ${key}`);

    if (connection.type === "discord" && connection.client) {
      try {
        connection.client.destroy();
      } catch (e) {
        // 忽略销毁错误
      }
    }

    connection.status = "disconnected";
    this.connections.delete(key);
    this.notifyListeners(key, connection);
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    const keys = Array.from(this.connections.keys());
    for (const key of keys) {
      await this.disconnect(key);
    }
  }
}

// 导出单例
export const connectionPool = new ConnectionPoolManager();

