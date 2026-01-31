/**
 * 实例管理器 - 管理转发实例的生命周期
 *
 * 核心职责：
 * - 启动/停止实例
 * - 从连接池获取/释放连接
 * - 管理消息事件订阅
 * - 协调多个实例共享同一连接
 */

import { connectionPool, type DiscordConnection, type DiscordClient } from "./connectionPool.js";
import { FileLogger } from "./logger.js";
import type { AccountConfig, MultiConfig } from "./config.js";

// 实例状态
export type InstanceStatus = "stopped" | "starting" | "running" | "stopping" | "error";

// 实例信息
export interface InstanceInfo {
  id: string;
  config: AccountConfig;
  status: InstanceStatus;
  error?: string;
  // 连接池 key
  listenerConnectionKey?: string;
  senderConnectionKey?: string;
  // 消息处理器 ID（用于取消订阅）
  messageHandlerId?: string;
}

// 消息处理器类型
type MessageHandler = (message: any, instanceId: string) => Promise<void>;

/**
 * 实例管理器类
 */
class InstanceManagerClass {
  private instances = new Map<string, InstanceInfo>();
  private messageHandlers = new Map<string, Set<{ instanceId: string; handler: MessageHandler }>>();
  private logger: FileLogger | null = null;

  setLogger(logger: FileLogger) {
    this.logger = logger;
    connectionPool.setLogger(logger);
  }

  /**
   * 获取实例信息
   */
  getInstance(id: string): InstanceInfo | undefined {
    return this.instances.get(id);
  }

  /**
   * 获取所有实例
   */
  getAllInstances(): Map<string, InstanceInfo> {
    return new Map(this.instances);
  }

  /**
   * 获取实例状态
   */
  getStatus(id: string): InstanceStatus {
    return this.instances.get(id)?.status || "stopped";
  }

  /**
   * 启动实例
   */
  async start(config: AccountConfig, messageHandler: MessageHandler): Promise<void> {
    const id = config.id;

    // 检查是否已在运行
    const existing = this.instances.get(id);
    if (existing && existing.status === "running") {
      await this.logger?.info(`[InstanceManager] 实例 ${config.name} 已在运行中`);
      return;
    }

    // 创建实例信息
    const instance: InstanceInfo = {
      id,
      config,
      status: "starting",
    };
    this.instances.set(id, instance);

    try {
      await this.logger?.info(`[InstanceManager] 正在启动实例: ${config.name}`);

      // 获取监听账号连接
      if (config.token) {
        const { key } = await connectionPool.acquireDiscord(
          config.token,
          config.type
        );
        instance.listenerConnectionKey = key;

        // 订阅消息事件
        this.subscribeToMessages(key, id, messageHandler);
      }

      instance.status = "running";
      await this.logger?.info(`[InstanceManager] 实例启动成功: ${config.name}`);
    } catch (error: any) {
      instance.status = "error";
      instance.error = error.message;
      await this.logger?.error(`[InstanceManager] 实例启动失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 停止实例
   */
  async stop(id: string): Promise<void> {
    const instance = this.instances.get(id);
    if (!instance) return;

    instance.status = "stopping";
    await this.logger?.info(`[InstanceManager] 正在停止实例: ${instance.config.name}`);

    // 取消消息订阅
    if (instance.listenerConnectionKey) {
      this.unsubscribeFromMessages(instance.listenerConnectionKey, id);
      await connectionPool.release(instance.listenerConnectionKey);
    }

    if (instance.senderConnectionKey && instance.senderConnectionKey !== instance.listenerConnectionKey) {
      await connectionPool.release(instance.senderConnectionKey);
    }

    instance.status = "stopped";
    this.instances.delete(id);
    await this.logger?.info(`[InstanceManager] 实例已停止: ${instance.config.name}`);
  }

  /**
   * 订阅消息事件
   */
  private subscribeToMessages(connectionKey: string, instanceId: string, handler: MessageHandler): void {
    if (!this.messageHandlers.has(connectionKey)) {
      this.messageHandlers.set(connectionKey, new Set());

      // 为这个连接设置消息监听器
      const connection = connectionPool.getConnection(connectionKey);
      if (connection?.type === "discord" && connection.client) {
        (connection.client as any).on("messageCreate", async (message: any) => {
          const handlers = this.messageHandlers.get(connectionKey);
          if (handlers) {
            for (const { instanceId, handler } of handlers) {
              try {
                await handler(message, instanceId);
              } catch (e) {
                // 忽略处理器错误
              }
            }
          }
        });
      }
    }

    this.messageHandlers.get(connectionKey)!.add({ instanceId, handler });
  }

  /**
   * 取消消息订阅
   */
  private unsubscribeFromMessages(connectionKey: string, instanceId: string): void {
    const handlers = this.messageHandlers.get(connectionKey);
    if (handlers) {
      for (const entry of handlers) {
        if (entry.instanceId === instanceId) {
          handlers.delete(entry);
          break;
        }
      }
    }
  }

  /**
   * 停止所有实例
   */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.instances.keys());
    for (const id of ids) {
      await this.stop(id);
    }
  }
}

// 导出单例
export const instanceManager = new InstanceManagerClass();

