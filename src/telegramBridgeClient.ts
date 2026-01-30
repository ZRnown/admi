/**
 * Telegram Bridge IPC 客户端
 * 通过 stdio 与 Telegram Bridge Python 进程通信
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";

export interface TelegramBridgeMessage {
  text?: string;
  photo?: string; // URL
  video?: string; // URL
  document?: string; // URL
  caption?: string;
  parse_mode?: string;
  reply_to_message_id?: string | number;
  watermark?: any;
  watermarkSecondary?: any;
  watermarks?: any;
}

export interface SendMessageParams {
  accountId: string;
  accountType: "client" | "bot";
  chatId: string | number;
  message: TelegramBridgeMessage;
  media?: any;
}

export interface UpdateConfigParams {
  accounts: any[];
  mappings: any[];
}

export interface HandleDiscordMessageParams {
  channelId: string;
  message: {
    id: string;
    content?: string;
    author: {
      username?: string;
      avatarURL?: string;
    };
    watermark?: any;
    watermarkSecondary?: any;
    watermarks?: any;
    attachments?: Array<{
      url: string;
      contentType?: string;
      name?: string;
    }>;
    embeds?: any[];
  };
}

interface RPCRequest {
  id: string;
  method: string;
  params: any;
}

interface RPCResponse {
  id: string;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
}

interface RPCNotification {
  method: string;
  params: any;
}

export class TelegramBridgeClient extends EventEmitter {
  private process: any; // ChildProcess
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  private messageBuffer: string = "";

  constructor(process: any) {
    super();
    this.process = process;
    this.pendingRequests = new Map();
    this._setupIPC();
  }

  private _setupIPC() {
    if (!this.process || !this.process.stdout || !this.process.stdin) {
      throw new Error("Telegram Bridge process is not initialized");
    }

    // 监听来自 Bridge 的消息
    this.process.stdout.on("data", (data: Buffer) => {
      this._handleData(data.toString("utf-8"));
    });

    this.process.stderr.on("data", (data: Buffer) => {
      // stderr 已由进程管理器统一输出，这里避免重复日志
    });

    this.process.on("error", (error: Error) => {
      console.error("[Telegram Bridge Process Error]", error);
      this.emit("error", error);
    });

    this.process.on("exit", (code: number) => {
      console.log(`[Telegram Bridge] Process exited with code ${code}`);
      this.emit("exit", code);
      // 拒绝所有等待的请求
      for (const [id, { reject }] of this.pendingRequests) {
        reject(new Error("Telegram Bridge process exited"));
      }
      this.pendingRequests.clear();
    });
  }

  private _handleData(data: string) {
    this.messageBuffer += data;

    // 按行分割消息
    const lines = this.messageBuffer.split("\n");
    this.messageBuffer = lines.pop() || ""; // 保留最后不完整的行

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed);
        this._handleMessage(message);
      } catch (error) {
        console.error("[Telegram Bridge] Failed to parse message:", trimmed, error);
      }
    }
  }

  private _handleMessage(message: RPCResponse | RPCNotification) {
    // 检查是否是响应
    if ("id" in message) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if ("method" in message) {
      // 通知消息
      this.emit(message.method, message.params);
    }
  }

  /**
   * 发送 RPC 请求
   */
  private async _sendRequest(method: string, params: any): Promise<any> {
    const id = randomUUID();
    const request: RPCRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // 发送请求
      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message, (error: Error | null) => {
        if (error) {
          this.pendingRequests.delete(id);
          reject(error);
        }
      });

      // 设置超时
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000); // 30秒超时
    });
  }

  /**
   * 更新配置
   */
  async updateConfig(params: UpdateConfigParams): Promise<{ success: boolean }> {
    return this._sendRequest("updateConfig", params);
  }

  /**
   * 发送消息到 Telegram
   */
  async sendMessage(params: SendMessageParams): Promise<any> {
    return this._sendRequest("sendMessage", params);
  }

  /**
   * 处理来自 Discord 的消息（转发到 Telegram）
   */
  async handleDiscordMessage(params: HandleDiscordMessageParams): Promise<{ success: boolean }> {
    return this._sendRequest("handleDiscordMessage", params);
  }

  /**
   * 连接 Telegram Bot
   */
  async connectBot(accountId: string, token: string): Promise<any> {
    return this._sendRequest("connectBot", { accountId, token });
  }

  /**
   * 连接 Telegram Client
   */
  async connectClient(account: any): Promise<any> {
    return this._sendRequest("connectClient", account);
  }

  /**
   * 断开 Telegram Client
   */
  async disconnectClient(accountId: string): Promise<any> {
    return this._sendRequest("disconnectClient", { accountId });
  }

  /**
   * 获取 Client 状态
   */
  async getClientStatus(accountId: string): Promise<any> {
    return this._sendRequest("getClientStatus", { accountId });
  }

  /**
   * 获取 Client 可用频道
   */
  async getClientChannels(accountId: string): Promise<any> {
    return this._sendRequest("getClientChannels", { accountId });
  }

  /**
   * 开始 Telegram Client 手机号登录（发送验证码）
   */
  async startClientLogin(params: { phoneNumber: string; apiId: number; apiHash: string; proxyUrl?: string }): Promise<any> {
    return this._sendRequest("startClientLogin", params);
  }

  /**
   * 完成 Telegram Client 登录（提交验证码）
   */
  async confirmClientLogin(params: { loginId: string; code: string; password?: string }): Promise<any> {
    return this._sendRequest("confirmClientLogin", params);
  }

  /**
   * 断开 Telegram Bot
   */
  async disconnectBot(accountId: string): Promise<any> {
    return this._sendRequest("disconnectBot", { accountId });
  }

  /**
   * 获取 Bot 状态
   */
  async getBotStatus(accountId: string): Promise<any> {
    return this._sendRequest("getBotStatus", { accountId });
  }

  /**
   * 获取 Bot 可用频道
   */
  async getBotChannels(accountId: string): Promise<any> {
    return this._sendRequest("getBotChannels", { accountId });
  }

  /**
   * 清理资源
   */
  destroy() {
    this.removeAllListeners();
    this.pendingRequests.clear();
  }
}
