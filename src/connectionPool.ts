/**
 * 全局 Discord 账号管理器
 *
 * 核心逻辑：
 * - 使用 Account ID 作为 Key（而非 Token Hash）
 * - 项目启动时自动登录所有账号库中的账号
 * - 账号连接与实例无关，只要在库里且有 Token 就保持在线
 * - 实例只是规则的挂载/卸载，不影响账号连接
 */

import { Client as SelfBotClient } from "discord.js-selfbot-v13";
import { Client as BotClient, GatewayIntentBits, Partials } from "discord.js";
import { EventEmitter } from "events";
import { FileLogger } from "./logger.js";
import type { DiscordAccountLibrary } from "./config.js";

// Discord Client 类型
export type DiscordClient = SelfBotClient | BotClient;

// 连接状态
export type AccountStatus = "online" | "connecting" | "error" | "offline";

// 已连接的账号信息
interface ConnectedAccount {
  client: DiscordClient;
  info: DiscordAccountLibrary;
  status: AccountStatus;
  reconnectTimer?: NodeJS.Timeout;
}

// 状态写入函数类型（避免循环引用）
type StatusWriter = (accountId: string, state: string, message: string) => Promise<void>;

/**
 * 全局 Discord 账号管理器
 */
export class GlobalDiscordManager extends EventEmitter {
  private accounts = new Map<string, ConnectedAccount>();
  private logger: FileLogger | null = null;
  private statusWriter: StatusWriter | null = null;

  setLogger(logger: FileLogger) {
    this.logger = logger;
  }

  setStatusWriter(writer: StatusWriter) {
    this.statusWriter = writer;
  }

  /**
   * 获取客户端供实例使用
   */
  getClient(accountId: string): DiscordClient | undefined {
    return this.accounts.get(accountId)?.client;
  }

  /**
   * 检查账号是否在线
   */
  isOnline(accountId: string): boolean {
    return this.accounts.get(accountId)?.status === "online";
  }

  /**
   * 获取账号状态
   */
  getStatus(accountId: string): AccountStatus | undefined {
    return this.accounts.get(accountId)?.status;
  }

  /**
   * 获取所有账号
   */
  getAllAccounts(): Map<string, ConnectedAccount> {
    return new Map(this.accounts);
  }

  /**
   * 同步账号库配置（启动/停止账号）
   */
  async syncAccounts(library: DiscordAccountLibrary[]) {
    const newIds = new Set(library.map(a => a.id));
    const libraryById = new Map(library.map(a => [a.id, a]));

    // 1. 清理不在库中的账号
    for (const [id, session] of this.accounts) {
      const nextConfig = libraryById.get(id);
      const shouldDisable = nextConfig?.loginEnabled === false || !nextConfig?.token;
      if (!newIds.has(id)) {
        this.logger?.info(`[AccountManager] 账号 ${session.info.name} 已从库中移除，正在断开...`);
        await this.disconnect(id);
      } else if (shouldDisable) {
        this.logger?.info(`[AccountManager] 账号 ${session.info.name} 已停用，正在断开...`);
        await this.disconnect(id);
      }
    }

    // 2. 启动或更新账号
    for (const accConfig of library) {
      const loginEnabled = accConfig.loginEnabled !== false;
      if (!loginEnabled) {
        await this.updateStatus(accConfig.id, "idle", "未启用");
        continue;
      }
      if (!accConfig.token) {
        await this.updateStatus(accConfig.id, "error", "未配置 Token");
        continue;
      }
      const existing = this.accounts.get(accConfig.id);

      // 如果 Token 变了，或者之前没启动
      if (!existing || existing.info.token !== accConfig.token) {
        if (existing) await this.disconnect(accConfig.id); // Token 变了先断开
        this.connect(accConfig).catch((err) => {
          this.logger?.error(`[AccountManager] 账号 ${accConfig.name} 登录异常: ${err?.message || err}`);
        });
      }
    }
  }

  /**
   * 连接单个账号
   */
  async connect(config: DiscordAccountLibrary) {
    if (this.accounts.has(config.id)) return;

    this.logger?.info(`[AccountManager] 正在连接账号: ${config.name}`);
    await this.updateStatus(config.id, "connecting", "正在登录...");

    const client = config.type === "bot"
      ? new BotClient({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel, Partials.Message],
        })
      : new SelfBotClient({
          checkUpdate: false,
          patchVoice: false,
          syncStatus: false
        } as any);

    const session: ConnectedAccount = {
      client,
      info: config,
      status: "connecting"
    };
    this.accounts.set(config.id, session);

    (client as any).on("ready", async () => {
      session.status = "online";
      const display = client.user?.tag || client.user?.username || config.name;
      this.logger?.info(`[AccountManager] 账号 ${config.name} 已连接: ${display}`);
      await this.updateStatus(config.id, "online", `已连接: ${display}`);
      this.emit("ready", config.id, client);
    });

    (client as any).on("error", (err: any) => {
      const msg = err?.message || String(err);
      this.logger?.error(`[AccountManager] 账号 ${config.name} 错误: ${msg}`);
      this.updateStatus(config.id, "error", msg).catch(() => {});
    });

    // 自动重连逻辑
    (client as any).on("disconnect", () => {
      if (session.status !== "offline") { // 非手动断开
        session.status = "error";
        this.updateStatus(config.id, "pending", "连接断开，正在重连...");
        this.logger?.warn(`[AccountManager] 账号 ${config.name} 断开，5秒后重连...`);
        if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
        session.reconnectTimer = setTimeout(() => {
          this.accounts.delete(config.id); // 清理旧引用
          this.connect(config).catch(e => console.error(e));
        }, 5000);
      }
    });

    try {
      await (client as any).login(config.token);
    } catch (e: any) {
      this.logger?.error(`[AccountManager] 账号 ${config.name} 登录失败: ${e.message}`);
      await this.updateStatus(config.id, "error", e.message);
      this.accounts.delete(config.id);
    }
  }

  /**
   * 断开单个账号
   */
  async disconnect(id: string) {
    const session = this.accounts.get(id);
    if (!session) return;

    session.status = "offline"; // 标记为离线，防止触发自动重连
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);

    try {
      await (session.client as any).destroy();
    } catch (e) {
      // ignore
    }

    this.accounts.delete(id);
    await this.updateStatus(id, "idle", "已断开");
    this.logger?.info(`[AccountManager] 账号 ${session.info.name} 已断开`);
  }

  /**
   * 断开所有账号
   */
  async disconnectAll() {
    const ids = Array.from(this.accounts.keys());
    for (const id of ids) {
      await this.disconnect(id);
    }
  }

  /**
   * 辅助方法：更新状态文件
   */
  private async updateStatus(accountId: string, state: string, message: string) {
    if (this.statusWriter) {
      await this.statusWriter(accountId, state, message);
    }
  }
}

// 导出单例
export const discordManager = new GlobalDiscordManager();
