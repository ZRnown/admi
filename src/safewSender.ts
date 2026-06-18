import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

export interface SafewAttachment {
  url: string;
  filename?: string;
  isImage?: boolean;
  isVideo?: boolean;
}

export interface SafewSendPayload {
  content?: string;
  sourceMessageId?: string;
  replyToTargetMessageId?: string | number;
  attachments?: SafewAttachment[];
  embeds?: any[];
}

export interface SafewSendResult {
  sourceMessageId?: string;
  targetMessageId?: string;
  targetChannelId: string;
}

const SAFEW_TEXT_CHUNK = 3800;
const SAFEW_CAPTION_CHUNK = 900;

function splitTextByLimit(text: string, limit: number): string[] {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut < Math.floor(limit * 0.5)) {
      cut = limit;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export class SafewSender {
  readonly botToken: string;
  readonly chatId: string;
  readonly apiBaseUrl: string;
  readonly httpAgent?: unknown;
  readonly maxUploadBytes: number;

  constructor(options: {
    botToken: string;
    chatId: string;
    apiBaseUrl?: string;
    httpAgent?: unknown;
    maxUploadBytes?: number;
  }) {
    this.botToken = String(options.botToken || "").trim().replace(/^bot\s+/i, "");
    this.chatId = String(options.chatId || "").trim();
    this.apiBaseUrl = String(options.apiBaseUrl || "https://api.safew.bot").trim().replace(/\/+$/, "");
    this.httpAgent = options.httpAgent;
    this.maxUploadBytes = Number.isFinite(options.maxUploadBytes) && Number(options.maxUploadBytes) > 0
      ? Number(options.maxUploadBytes)
      : 50 * 1024 * 1024;
  }

  private buildMethodUrl(method: "sendmessage" | "sendphoto" | "sendvideo"): URL {
    if (!this.botToken) {
      throw new Error("SafeW Bot Token 未配置");
    }
    return new URL(`${this.apiBaseUrl}/bot${encodeURIComponent(this.botToken)}/${method}`);
  }

  private normalizeReplyId(value?: string | number): string | number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return undefined;
    const numeric = Number(raw);
    return Number.isSafeInteger(numeric) ? numeric : raw;
  }

  private collectEmbedText(embeds?: any[]): string {
    if (!Array.isArray(embeds) || embeds.length === 0) return "";
    const parts: string[] = [];
    for (const embed of embeds) {
      if (!embed || typeof embed !== "object") continue;
      for (const value of [embed.title, embed.description]) {
        if (typeof value === "string" && value.trim()) parts.push(value.trim());
      }
      if (Array.isArray(embed.fields)) {
        for (const field of embed.fields) {
          const name = typeof field?.name === "string" ? field.name.trim() : "";
          const fieldValue = typeof field?.value === "string" ? field.value.trim() : "";
          if (name || fieldValue) parts.push([name, fieldValue].filter(Boolean).join("\n"));
        }
      }
    }
    return parts.join("\n");
  }

  private buildContent(payload: SafewSendPayload): string {
    const parts = [
      typeof payload.content === "string" ? payload.content.trim() : "",
      this.collectEmbedText(payload.embeds),
    ].filter(Boolean);
    return parts.join("\n");
  }

  private extractMessageId(response: any): string | undefined {
    const candidates = [
      response?.result?.message_id,
      response?.result?.id,
      response?.message_id,
      response?.id,
      response?.data?.message_id,
      response?.data?.id,
    ];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null) continue;
      const value = String(candidate).trim();
      if (value) return value;
    }
    return undefined;
  }

  private async requestJson(method: "sendmessage" | "sendphoto" | "sendvideo", body: Record<string, any>): Promise<any> {
    if (!this.chatId) {
      throw new Error("SafeW 群组 ID 未配置");
    }
    const url = this.buildMethodUrl(method);
    const payload = JSON.stringify({
      chat_id: this.chatId,
      ...body,
    });

    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      agent: this.httpAgent as any,
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed: any = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (parsed?.ok === false) {
              reject(new Error(`SafeW API failed: ${parsed.description || parsed.message || raw}`));
              return;
            }
            resolve(parsed);
            return;
          }
          reject(new Error(`SafeW API failed ${res.statusCode}: ${res.statusMessage || ""} ${raw}`));
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error("SafeW request timeout"));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  private sanitizeFilename(value?: string): string {
    const raw = String(value || "").trim();
    const filename = raw.split(/[\\/]/).pop()?.replace(/[\r\n"]/g, "_").trim();
    return filename || "attachment";
  }

  private async downloadAttachment(attachment: SafewAttachment): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
    const url = new URL(attachment.url);
    const requestLib = url.protocol === "http:" ? http : https;
    const filename = this.sanitizeFilename(attachment.filename || decodeURIComponent(url.pathname.split("/").pop() || ""));
    const fallbackContentType = attachment.isVideo ? "video/mp4" : "image/jpeg";

    return await new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        method: "GET",
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          "User-Agent": "DiscordBotWork/1.0",
        },
        agent: this.httpAgent as any,
      };
      const req = requestLib.request(options, (res) => {
        const statusCode = res.statusCode || 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : "";
        if (statusCode >= 300 && statusCode < 400 && location) {
          res.resume();
          const redirectUrl = new URL(location, url);
          this.downloadAttachment({ ...attachment, url: redirectUrl.toString(), filename }).then(resolve, reject);
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          reject(new Error(`SafeW media download failed ${statusCode}: ${res.statusMessage || ""}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > this.maxUploadBytes) {
            req.destroy(new Error(`SafeW media exceeds upload limit ${this.maxUploadBytes} bytes`));
            return;
          }
          chunks.push(buffer);
        });
        res.on("end", () => {
          const contentType = String(res.headers["content-type"] || fallbackContentType).split(";")[0].trim() || fallbackContentType;
          resolve({ buffer: Buffer.concat(chunks), contentType, filename });
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error("SafeW media download timeout"));
      });
      req.on("error", reject);
      req.end();
    });
  }

  private async requestMultipart(
    method: "sendphoto" | "sendvideo",
    fields: Record<string, string | number | undefined>,
    fileField: "photo" | "video",
    file: { buffer: Buffer; contentType: string; filename: string },
  ): Promise<any> {
    if (!this.chatId) {
      throw new Error("SafeW 群组 ID 未配置");
    }
    const url = this.buildMethodUrl(method);
    const boundary = `----safew-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const parts: Buffer[] = [];
    const push = (value: string | Buffer) => {
      parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    };

    for (const [key, value] of Object.entries({ chat_id: this.chatId, ...fields })) {
      if (value === undefined || value === "") continue;
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="${key}"\r\n\r\n`);
      push(`${value}\r\n`);
    }
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="${fileField}"; filename="${this.sanitizeFilename(file.filename)}"\r\n`);
    push(`Content-Type: ${file.contentType || "application/octet-stream"}\r\n\r\n`);
    push(file.buffer);
    push("\r\n");
    push(`--${boundary}--\r\n`);

    const payload = Buffer.concat(parts);
    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length,
      },
      agent: this.httpAgent as any,
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed: any = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            if (parsed?.ok === false) {
              reject(new Error(`SafeW API failed: ${parsed.description || parsed.message || raw}`));
              return;
            }
            resolve(parsed);
            return;
          }
          reject(new Error(`SafeW API failed ${res.statusCode}: ${res.statusMessage || ""} ${raw}`));
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error("SafeW request timeout"));
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  async send(payload: SafewSendPayload): Promise<SafewSendResult | undefined> {
    const content = this.buildContent(payload);
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const replyToMessageId = this.normalizeReplyId(payload.replyToTargetMessageId);
    const common = replyToMessageId !== undefined ? { reply_to_message_id: replyToMessageId } : {};
    let firstResponse: any;
    const captionChunks = splitTextByLimit(content, SAFEW_CAPTION_CHUNK);
    const firstCaption = captionChunks.shift();

    for (const attachment of attachments) {
      if (!attachment?.url) continue;
      if (attachment.isImage) {
        const file = await this.downloadAttachment(attachment);
        const response = await this.requestMultipart("sendphoto", {
          caption: firstCaption || undefined,
          ...common,
        }, "photo", file);
        firstResponse = firstResponse || response;
        continue;
      }
      if (attachment.isVideo) {
        const file = await this.downloadAttachment(attachment);
        const response = await this.requestMultipart("sendvideo", {
          caption: firstCaption || undefined,
          ...common,
        }, "video", file);
        firstResponse = firstResponse || response;
      }
    }

    const textChunks = attachments.length > 0 ? captionChunks : splitTextByLimit(content, SAFEW_TEXT_CHUNK);
    for (const text of textChunks) {
      const response = await this.requestJson("sendmessage", {
        text,
        ...common,
      });
      firstResponse = firstResponse || response;
    }

    if (!firstResponse) return undefined;
    return {
      sourceMessageId: payload.sourceMessageId,
      targetMessageId: this.extractMessageId(firstResponse),
      targetChannelId: this.chatId,
    };
  }
}
