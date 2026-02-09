/**
 * Discord Bridge IPC client
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";

interface RPCRequest {
  id: string;
  method: string;
  params: any;
}

interface RPCResponse {
  id: string;
  result?: any;
  error?: { code: number; message: string };
}

interface RPCNotification {
  method: string;
  params: any;
}

export interface DiscordBridgeAccountConfig {
  id: string;
  token: string;
  type?: "bot" | "selfbot";
  enabled?: boolean;
  listenChannels?: string[];
}

export interface DiscordBridgeUpdateConfigParams {
  accounts: DiscordBridgeAccountConfig[];
}

export interface DiscordBridgeUpload {
  url?: string;
  localPath?: string;
  filename?: string;
}

export interface DiscordBridgeSendChannelParams {
  accountId: string;
  channelId: string;
  content?: string;
  uploads?: DiscordBridgeUpload[];
}

export interface DiscordBridgeSendDmParams {
  accountId: string;
  friendId: string;
  content?: string;
  uploads?: DiscordBridgeUpload[];
}

export class DiscordBridgeClient extends EventEmitter {
  private process: any;
  private pendingRequests: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>;
  private messageBuffer = "";
  private stdoutHandler?: (data: Buffer) => void;
  private stderrHandler?: (data: Buffer) => void;
  private errorHandler?: (error: Error) => void;
  private exitHandler?: (code: number) => void;

  constructor(process: any) {
    super();
    this.process = process;
    this.pendingRequests = new Map();
    this._setupIPC();
  }

  isForProcess(process: any): boolean {
    return this.process === process;
  }

  destroy() {
    this.removeAllListeners();
    this.pendingRequests.clear();
    if (this.process?.stdout && this.stdoutHandler) {
      this.process.stdout.off("data", this.stdoutHandler);
    }
    if (this.process?.stderr && this.stderrHandler) {
      this.process.stderr.off("data", this.stderrHandler);
    }
    if (this.process && this.errorHandler) {
      this.process.off("error", this.errorHandler);
    }
    if (this.process && this.exitHandler) {
      this.process.off("exit", this.exitHandler);
    }
  }

  private _setupIPC() {
    if (!this.process || !this.process.stdout || !this.process.stdin) {
      throw new Error("Discord Bridge process is not initialized");
    }

    this.stdoutHandler = (data: Buffer) => {
      this._handleData(data.toString("utf-8"));
    };
    this.stderrHandler = () => {
      // stderr handled by process manager
    };
    this.errorHandler = (error: Error) => {
      console.error("[Discord Bridge Process Error]", error);
      this.emit("error", error);
    };
    this.exitHandler = (code: number) => {
      console.log(`[Discord Bridge] Process exited with code ${code}`);
      this.emit("exit", code);
      for (const [, { reject }] of this.pendingRequests) {
        reject(new Error("Discord Bridge process exited"));
      }
      this.pendingRequests.clear();
    };

    this.process.stdout.on("data", this.stdoutHandler);
    this.process.stderr.on("data", this.stderrHandler);
    this.process.on("error", this.errorHandler);
    this.process.on("exit", this.exitHandler);
  }

  private _handleData(data: string) {
    this.messageBuffer += data;
    const lines = this.messageBuffer.split("\n");
    this.messageBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed);
        this._handleMessage(message);
      } catch (error) {
        console.error("[Discord Bridge] Failed to parse message:", trimmed, error);
      }
    }
  }

  private _handleMessage(message: RPCResponse | RPCNotification) {
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
      this.emit(message.method, message.params);
    }
  }

  private async _sendRequest(method: string, params: any): Promise<any> {
    const id = randomUUID();
    const request: RPCRequest = { id, method, params };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      const message = JSON.stringify(request) + "\n";
      this.process.stdin.write(message, (error: Error | null) => {
        if (error) {
          this.pendingRequests.delete(id);
          reject(error);
        }
      });
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  async updateConfig(params: DiscordBridgeUpdateConfigParams): Promise<{ success: boolean; accounts?: number }> {
    return this._sendRequest("updateConfig", params);
  }

  async sendChannelMessage(
    params: DiscordBridgeSendChannelParams,
  ): Promise<{ success: boolean; messageId?: string; channelId?: string; error?: string }> {
    return this._sendRequest("sendChannelMessage", params);
  }

  async sendDmMessage(
    params: DiscordBridgeSendDmParams,
  ): Promise<{ success: boolean; messageId?: string; channelId?: string; error?: string }> {
    return this._sendRequest("sendDmMessage", params);
  }
}
