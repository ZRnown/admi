import https from "node:https";
import { URL } from "node:url";

import { ChannelId } from "./config.js";

export class SenderBot {
  replacementsDictionary: Record<string, string> = {};

  webhookUrl: string;
  httpAgent?: unknown;
  webhookGuildId?: string;
  defaultChannelId?: string;
  webhookName?: string;
  enableTranslation?: boolean;
  deepseekApiKey?: string;

  constructor(options: {
    replacementsDictionary?: Record<string, string>;
    webhookUrl: string;
    httpAgent?: unknown; // 由 proxy-agent 创建的 Agent，可选
    enableTranslation?: boolean;
    deepseekApiKey?: string;
  }) {
    this.replacementsDictionary = options.replacementsDictionary || {};
    this.webhookUrl = options.webhookUrl;
    this.httpAgent = options.httpAgent;
    this.enableTranslation = options.enableTranslation || false;
    this.deepseekApiKey = options.deepseekApiKey;
  }

  private async postMultipart(body: Record<string, any>, files: Array<{ filename: string; buffer: Buffer }>, wait = false): Promise<any> {
    const url = new URL(this.webhookUrl);
    if (wait) url.searchParams.set("wait", "true");

    const boundary = "----cascadeform" + Math.random().toString(16).slice(2);

    const parts: Buffer[] = [];
    const push = (chunk: string | Buffer) => parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);

    // payload_json part
    push(`--${boundary}\r\n`);
    push(`Content-Disposition: form-data; name="payload_json"\r\n`);
    push(`Content-Type: application/json\r\n\r\n`);
    push(JSON.stringify(body));
    push(`\r\n`);

    // files
    files.forEach((f, idx) => {
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="files[${idx}]"; filename="${f.filename}"\r\n`);
      push(`Content-Type: application/octet-stream\r\n\r\n`);
      push(f.buffer);
      push(`\r\n`);
    });

    // end boundary
    push(`--${boundary}--\r\n`);

    const payload = Buffer.concat(parts);

    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.byteLength
      },
      agent: this.httpAgent as any
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(body ? JSON.parse(body) : null);
            } catch {
              resolve(null);
            }
          } else {
            reject(new Error(`Webhook multipart failed ${res.statusCode}: ${res.statusMessage} ${body || ""}`));
          }
        });
      });
      req.setTimeout(15000, () => {
        req.destroy(new Error("Webhook multipart request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async downloadUploads(uploads: Array<{ url: string; filename: string; isImage?: boolean }>): Promise<Array<{ filename: string; buffer: Buffer; isImage?: boolean }>> {
    const results: Array<{ filename: string; buffer: Buffer; isImage?: boolean }> = [];
    for (const u of uploads) {
      const buf = await this.downloadUrl(u.url);
      results.push({ filename: u.filename, buffer: buf, isImage: u.isImage });
    }
    return results;
  }

  private async downloadUrl(fileUrl: string): Promise<Buffer> {
    const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024; // 10MB limit
    const DOWNLOAD_TIMEOUT_MS = 20000; // 20s
    const u = new URL(fileUrl);
    const options: https.RequestOptions = {
      method: "GET",
      hostname: u.hostname,
      path: u.pathname + u.search,
      agent: this.httpAgent as any
    };
    return await new Promise<Buffer>((resolve, reject) => {
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (d) => {
          const b = d as Buffer;
          total += b.length;
          if (total > MAX_DOWNLOAD_BYTES) {
            req.destroy(new Error("Download exceeded max size limit"));
            return;
          }
          chunks.push(b);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
      });
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error("Download timeout"));
      });
      req.on("error", (e) => reject(e));
      req.end();
    });
  }

  async prepare() {
    // 读取 webhook 元信息，拿到 guild_id、默认 channel_id 和名称
    try {
      const info = await this.getWebhookInfo();
      this.webhookGuildId = info.guild_id;
      this.defaultChannelId = info.channel_id;
      this.webhookName = info.name; // 保存 webhook 名称
    } catch {
      // 忽略失败，不影响基本发送
    }
  }

  /**
   * 检测文本是否全部是中文（只有全部是中文才返回 true，有英文就返回 false）
   */
  private isChinese(text: string): boolean {
    if (!text || text.trim().length === 0) {
      return false;
    }
    
    // 移除空白字符、标点符号和数字，只统计字母和中文字符
    const cleanedText = text.replace(/[\s\d\p{P}]/gu, "");
    if (cleanedText.length === 0) {
      return false;
    }
    
    // 检测是否有英文字母（包括大小写）
    const hasEnglish = /[a-zA-Z]/.test(cleanedText);
    
    // 如果有英文字母，说明不是纯中文，需要翻译
    if (hasEnglish) {
      return false;
    }
    
    // 如果没有英文字母，检查是否有中文字符
    const hasChinese = /[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/.test(cleanedText);
    
    // 如果有中文字符且没有英文字母，认为是纯中文，不翻译
    return hasChinese;
  }

  /**
   * 调用 DeepSeek API 进行翻译
   */
  private async translateText(text: string): Promise<string | null> {
    if (!this.enableTranslation) {
      console.log("[翻译] 翻译功能未启用");
      return null;
    }
    
    if (!this.deepseekApiKey) {
      console.log("[翻译] DeepSeek API Key 未配置");
      return null;
    }
    
    if (!text.trim()) {
      return null;
    }

    // 如果源文本是中文，不翻译
    if (this.isChinese(text)) {
      console.log("[翻译] 源文本是中文，跳过翻译");
      return null;
    }

    try {
      const url = new URL("https://api.deepseek.com/v1/chat/completions");
      const payload = JSON.stringify({
        model: "deepseek-chat",
        messages: [
          {
            role: "system",
            content: "你是一个专业的翻译助手。请将用户输入的内容中的英文部分翻译成中文，中文部分保持不变。如果内容完全是英文，则翻译成中文。如果内容包含中文，请保持中文不变，只翻译英文单词和句子。只返回翻译结果，不要添加任何解释或说明。"
          },
          {
            role: "user",
            content: text
          }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });

      const options: https.RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.deepseekApiKey}`,
          "Content-Length": Buffer.byteLength(payload)
        },
        agent: this.httpAgent as any
      };

      return await new Promise<string | null>((resolve, reject) => {
        const req = https.request(options, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = body ? JSON.parse(body) : null;
                const translatedText = json?.choices?.[0]?.message?.content?.trim();
                if (translatedText) {
                  console.log(`[翻译] 翻译成功: "${text.substring(0, 50)}..." -> "${translatedText.substring(0, 50)}..."`);
                  resolve(translatedText);
                } else {
                  console.log(`[翻译] API 返回格式异常，响应: ${body.substring(0, 200)}`);
                  resolve(null);
                }
              } catch (e) {
                console.error(`[翻译] 解析 API 响应失败:`, e, `响应: ${body.substring(0, 200)}`);
                resolve(null);
              }
            } else {
              // 翻译失败不影响消息发送，但记录错误
              console.error(`[翻译] API 请求失败: HTTP ${res.statusCode} ${res.statusMessage}, 响应: ${body.substring(0, 200)}`);
              resolve(null);
            }
          });
        });
        req.setTimeout(10000, () => {
          req.destroy();
          console.error("[翻译] 请求超时（10秒）");
          resolve(null); // 超时也不影响消息发送
        });
        req.on("error", (err) => {
          console.error("[翻译] 网络错误:", err);
          resolve(null); // 错误也不影响消息发送
        });
        req.write(payload);
        req.end();
      });
    } catch (e) {
      console.error("[翻译] 异常:", e);
      return null; // 任何错误都不影响消息发送
    }
  }

  async sendData(messagesToSend: Array<{
    content: string;
    sourceMessageId?: string;
    replyToSourceMessageId?: string;
    username?: string;
    avatarUrl?: string;
    replyToTarget?: { channelId: string; messageId: string };
    useEmbed?: boolean;
    extraEmbeds?: any[];
    uploads?: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }>;
    components?: any[];
  }>) {
    if (messagesToSend.length == 0) return;

    const results: Array<{
      sourceMessageId?: string;
      targetMessageId: string;
      targetChannelId: string;
    }> = [];

    for (const item of messagesToSend) {
      let text = item.content || "";
      for (const [a, b] of Object.entries(this.replacementsDictionary)) {
        text = text.replaceAll(a, b);
      }

      // 如果启用了翻译，尝试翻译文本
      if (this.enableTranslation && text.trim() && !this.isChinese(text)) {
        const translated = await this.translateText(text);
        if (translated) {
          // 格式：原文 + 横线 + 翻译
          text = `${text}\n\n---\n\n${translated}`;
        }
      }

      // Discord limits: content 2000, embed.description 4096
      const MESSAGE_CHUNK = item.useEmbed ? 4096 : 2000;
      const hasOnlyEmbeds = item.useEmbed === true && (item.extraEmbeds?.length || 0) > 0 && text.trim() === "";
      const hasUploads = (item.uploads?.length || 0) > 0;
      if (text.trim() === "" && !hasOnlyEmbeds && !hasUploads) continue;

      // 逐条发送（不分片回复映射会丢失），如超长则分段多条
      // If there are uploads, we will send exactly one message with multipart form.
      const loopCount = hasUploads ? 1 : Math.max(1, hasOnlyEmbeds ? 1 : Math.ceil(text.length / MESSAGE_CHUNK));
      for (let idx = 0; idx < loopCount; idx++) {
        const i = idx * MESSAGE_CHUNK;
        const chunk = text.substring(i, i + MESSAGE_CHUNK);
        let resp: any = null;
        if (hasUploads) {
          // Build multipart form with files and payload_json
          const files = await this.downloadUploads(item.uploads!);
          const desc = (chunk || "").slice(0, 4096);
          const embed: any = {};
          if (item.useEmbed && desc.trim() !== "") {
            embed.description = desc;
          }
          const firstImage = files.find((f) => f.isImage);
          if (item.useEmbed && firstImage) {
            embed.image = { url: `attachment://${firstImage.filename}` };
          }
          const payload: any = {
            content: item.useEmbed ? "" : (chunk || "").trim() || " ",
            allowed_mentions: { parse: [], replied_user: false },
          };
          if (item.useEmbed && Object.keys(embed).length > 0) {
            payload.embeds = [embed];
          }
          if (item.username) payload.username = item.username;
          if (item.avatarUrl) payload.avatar_url = item.avatarUrl;
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          // Provide attachments descriptors to map files indices for attachment://filename resolution
          if (files.length > 0) {
            payload.attachments = files.map((f, idx) => ({ id: idx, filename: f.filename }));
          }
          if (item.replyToTarget?.messageId) {
            payload.message_reference = { message_id: item.replyToTarget.messageId, fail_if_not_exists: false };
          }
          resp = await this.postMultipart(payload, files, true);
        } else {
          const payload: any = {
            allowed_mentions: { parse: [], replied_user: false }
          };
          if (item.useEmbed) {
            payload.content = "";
            const base = chunk ? [{ description: chunk }] : [];
            payload.embeds = [...base, ...((item.extraEmbeds as any[]) || [])];
          } else {
            payload.content = chunk;
          }
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          if (item.username) payload.username = item.username;
          if (item.avatarUrl) payload.avatar_url = item.avatarUrl;
          if (item.replyToTarget?.messageId) {
            payload.message_reference = { message_id: item.replyToTarget.messageId, fail_if_not_exists: false };
          }
          resp = await this.postToWebhook(payload, true);
        }
        if (resp?.id && resp?.channel_id) {
          results.push({
            sourceMessageId: i === 0 ? item.sourceMessageId : undefined,
            targetMessageId: String(resp.id),
            targetChannelId: String(resp.channel_id)
          });
        }
      }
    }

    return results;
  }

  private async postToWebhook(body: Record<string, any>, wait = false): Promise<any> {
    const url = new URL(this.webhookUrl);
    if (wait) {
      // 让服务端返回消息对象
      url.searchParams.set("wait", "true");
    }

    const payload = JSON.stringify(body);

    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      agent: this.httpAgent as any
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = "";
        // Drain response data to free up memory
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = body ? JSON.parse(body) : null;
              resolve(json);
            } catch {
              resolve(null);
            }
          } else {
            // 若 400 且包含 message_reference 可能不被支持，尝试去掉后重试一次
            if (res.statusCode === 400) {
              try {
                const parsed = JSON.parse(body || "{}");
                const hasRef = (payload && JSON.parse(payload).message_reference) ? true : false;
                if (hasRef) {
                  const retryBody = JSON.parse(payload);
                  delete retryBody.message_reference;
                  this.postToWebhook(retryBody, wait).then(resolve).catch(reject);
                  return;
                }
              } catch (_) {
                // ignore parse errors
              }
            }
            reject(new Error(`Webhook request failed with status ${res.statusCode}: ${res.statusMessage} ${body || ""}`));
          }
        });
      });
      req.setTimeout(15000, () => {
        req.destroy(new Error("Webhook request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async getWebhookInfo(): Promise<{ guild_id?: string; channel_id?: string; name?: string }> {
    const url = new URL(this.webhookUrl);
    const options: https.RequestOptions = {
      method: "GET",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        "Content-Type": "application/json"
      },
      agent: this.httpAgent as any
    };

    return await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            const json = body ? JSON.parse(body) : {};
            resolve(json);
          } catch (e) {
            resolve({});
          }
        });
      });
      req.on("error", (err) => reject(err));
      req.end();
    });
  }
}
