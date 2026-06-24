import { promises as fs } from "node:fs";
import https from "node:https";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";

import { ChannelId, WatermarkConfig, type WatermarkCoverConfig } from "./config.js";
import { applyWatermarksToBuffer, resolveWatermarkList } from "./watermark.js";
import {
  removeWatermarkFromImageUrl,
  shouldApplyWatermarkAfterRemoval,
  type WatermarkRemovalConfig,
  type WatermarkRemovalRuntimeState,
} from "./watermarkRemoval.js";
import {
  applyWatermarkCoverToImageBuffer,
  applyWatermarkCoverToVideoBuffer,
} from "./watermarkCover.js";
import { formatSize } from "./format.js";
import { stripLanguages } from "./languageFilter.js";
import { normalizeUploadFileDescriptor } from "./uploadMediaMetadata.js";
import { resolveWebhookIdentity } from "./webhookIdentity.js";
import { applyReplacementDictionaryToEmbeds } from "./embedUtils.js";
import { applyReplacementDictionary } from "./replacementDictionary.js";

const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;

interface SkippedUploadLink {
  filename: string;
  url?: string;
  size?: number;
  reason: string;
}

function looksLikeImage(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return true;
  }
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return true;
  }
  // BMP
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return true;
  }
  // WebP (RIFF....WEBP)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return true;
  }
  return false;
}

function parseOversizedBytes(message: string): number | undefined {
  const match = String(message || "").match(/File too large \((\d+) bytes\)/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function formatSkippedUploadLinks(skipped: SkippedUploadLink[]): string {
  if (skipped.length === 0) return "";
  const lines = skipped.map((item, index) => {
    const sizeText = item.size ? `，大小 ${formatSize(item.size)}` : "";
    const link = item.url ? `\n${item.url}` : "";
    return `${index + 1}. ${item.filename}${sizeText}：${item.reason}${link}`;
  });
  return `附件过大，已改为链接：\n${lines.join("\n")}`;
}

function appendSkippedUploadLinks(content: string, skipped: SkippedUploadLink[]): string {
  const note = formatSkippedUploadLinks(skipped);
  return [content, note].map((item) => String(item || "").trim()).filter(Boolean).join("\n\n");
}

export class SenderBot {
  replacementsDictionary: Record<string, string> = {};

  webhookUrl: string;
  httpAgent?: unknown;
  webhookGuildId?: string;
  defaultChannelId?: string;
  targetChannelId?: string;
  authToken?: string;
  authType?: "bot" | "selfbot";
  webhookName?: string;
  enableTranslation?: boolean;
  deepseekApiKey?: string;
  translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
  translationApiKey?: string;
  translationSecret?: string;
  translationBaseUrl?: string;
  translationModel?: string;
  translationPrompt?: string;
  enableBotRelay?: boolean;
  botRelayToken?: string;
  watermark?: WatermarkConfig;
  watermarkSecondary?: WatermarkConfig;
  watermarks?: WatermarkConfig[];
  watermarkEnabled?: boolean;
  targetWebhookName?: string;
  targetWebhookAvatarUrl?: string;

  constructor(options: {
    replacementsDictionary?: Record<string, string>;
    webhookUrl: string;
    httpAgent?: unknown; // 由 proxy-agent 创建的 Agent，可选
    enableTranslation?: boolean;
    deepseekApiKey?: string;
    translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
    translationApiKey?: string;
    translationSecret?: string;
    translationBaseUrl?: string;
    translationModel?: string;
    translationPrompt?: string;
    enableBotRelay?: boolean;
    botRelayToken?: string;
    targetChannelId?: string;
    authToken?: string;
    authType?: "bot" | "selfbot";
    watermark?: WatermarkConfig;
    watermarkSecondary?: WatermarkConfig;
    watermarks?: WatermarkConfig[];
    watermarkEnabled?: boolean;
    targetWebhookName?: string;
    targetWebhookAvatarUrl?: string;
  }) {
    this.replacementsDictionary = options.replacementsDictionary || {};
    this.webhookUrl = options.webhookUrl;
    this.httpAgent = options.httpAgent;
    this.enableTranslation = options.enableTranslation || false;
    this.deepseekApiKey = options.deepseekApiKey;
    this.translationProvider = options.translationProvider || "deepseek";
    this.translationApiKey = options.translationApiKey || options.deepseekApiKey;
    this.translationSecret = options.translationSecret;
    this.translationBaseUrl = options.translationBaseUrl;
    this.translationModel = options.translationModel;
    this.translationPrompt = options.translationPrompt;
    this.enableBotRelay = options.enableBotRelay || false;
    this.botRelayToken = options.botRelayToken;
    this.targetChannelId = options.targetChannelId;
    this.authToken = options.authToken;
    this.authType = options.authType;
    this.watermark = options.watermark;
    this.watermarkSecondary = options.watermarkSecondary;
    this.watermarks = options.watermarks;
    this.watermarkEnabled = options.watermarkEnabled;
    this.targetWebhookName = options.targetWebhookName;
    this.targetWebhookAvatarUrl = options.targetWebhookAvatarUrl;
  }

  private hasDirectChannelTarget(): boolean {
    return Boolean(this.targetChannelId && this.authToken);
  }

  private buildDiscordAuthorizationHeader(): string {
    const rawToken = String(this.authToken || "").trim();
    if (!rawToken) {
      throw new Error("Discord auth token is not configured");
    }
    const strippedToken = rawToken.toLowerCase().startsWith("bot ") ? rawToken.slice(4).trim() : rawToken;
    if (!strippedToken) {
      throw new Error("Discord auth token is empty");
    }
    return this.authType === "bot" ? `Bot ${strippedToken}` : strippedToken;
  }

  private async postDirectMessage(
    body: Record<string, any>,
    files: Array<{ filename: string; buffer: Buffer; contentType?: string }>,
    channelId?: string,
  ): Promise<any> {
    const resolvedChannelId = encodeURIComponent(String(channelId || this.targetChannelId || "").trim());
    if (!resolvedChannelId) {
      throw new Error("Discord target channel id is not configured");
    }
    const url = new URL(`https://discord.com/api/v10/channels/${resolvedChannelId}/messages`);
    const authorization = this.buildDiscordAuthorizationHeader();

    if (files.length > 0) {
      const boundary = "----cascadeform" + Math.random().toString(16).slice(2);
      const parts: Buffer[] = [];
      const push = (chunk: string | Buffer) => parts.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);

      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="payload_json"\r\n`);
      push(`Content-Type: application/json\r\n\r\n`);
      push(JSON.stringify(body));
      push(`\r\n`);

      files.forEach((f, idx) => {
        push(`--${boundary}\r\n`);
        push(`Content-Disposition: form-data; name="files[${idx}]"; filename="${f.filename}"\r\n`);
        push(`Content-Type: ${f.contentType || "application/octet-stream"}\r\n\r\n`);
        push(f.buffer);
        push(`\r\n`);
      });

      push(`--${boundary}--\r\n`);

      const payload = Buffer.concat(parts);
      const options: https.RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          "Authorization": authorization,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.byteLength,
        },
        agent: this.httpAgent as any,
      };

      return await new Promise<any>((resolve, reject) => {
        const req = https.request(options, (res) => {
          let responseBody = "";
          res.on("data", (chunk) => (responseBody += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(responseBody ? JSON.parse(responseBody) : null);
              } catch {
                resolve(null);
              }
              return;
            }
            reject(new Error(`Discord channel multipart failed ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`));
          });
        });
        req.setTimeout(30000, () => {
          req.destroy(new Error("Discord direct multipart request timeout"));
        });
        req.on("error", (err) => reject(err));
        req.write(payload);
        req.end();
      });
    }

    const payload = JSON.stringify(body);
    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        "Authorization": authorization,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      agent: this.httpAgent as any,
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(responseBody ? JSON.parse(responseBody) : null);
            } catch {
              resolve(null);
            }
            return;
          }
          if (res.statusCode === 400 && body.message_reference) {
            const retryBody = { ...body };
            delete retryBody.message_reference;
            this.postDirectMessage(retryBody, [], channelId).then(resolve).catch(reject);
            return;
          }
          reject(new Error(`Discord direct request failed ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`));
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error("Discord direct request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async patchDirectMessage(
    channelId: string,
    messageId: string,
    body: Record<string, any>,
  ): Promise<any> {
    const safeChannelId = encodeURIComponent(String(channelId || this.targetChannelId || "").trim());
    const safeMessageId = encodeURIComponent(String(messageId || "").trim());
    if (!safeChannelId || !safeMessageId) {
      throw new Error("Discord direct edit target is not configured");
    }
    const url = new URL(`https://discord.com/api/v10/channels/${safeChannelId}/messages/${safeMessageId}`);
    const payload = JSON.stringify(body);
    const options: https.RequestOptions = {
      method: "PATCH",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        "Authorization": this.buildDiscordAuthorizationHeader(),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      agent: this.httpAgent as any,
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(responseBody ? JSON.parse(responseBody) : null);
            } catch {
              resolve(null);
            }
            return;
          }
          reject(new Error(`Discord direct edit failed ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`));
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error("Discord direct edit request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async postMultipart(
    body: Record<string, any>,
    files: Array<{ filename: string; buffer: Buffer; contentType?: string }>,
    wait = false,
  ): Promise<any> {
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
      push(`Content-Type: ${f.contentType || "application/octet-stream"}\r\n\r\n`);
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
      req.setTimeout(30000, () => {
        req.destroy(new Error("Webhook multipart request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async downloadUploads(
    uploads: Array<{
      url?: string;
      localPath?: string;
      filename: string;
      isImage?: boolean;
      isVideo?: boolean;
      watermarkRemoval?: WatermarkRemovalConfig;
      watermarkRemovalState?: WatermarkRemovalRuntimeState;
      watermarkCover?: WatermarkCoverConfig;
    }>,
    watermark?: WatermarkConfig,
    watermarkSecondary?: WatermarkConfig,
    watermarks?: WatermarkConfig[],
  ): Promise<{
    files: Array<{ filename: string; buffer: Buffer; isImage?: boolean; contentType?: string }>;
    skipped: SkippedUploadLink[];
  }> {
    const results: Array<{ filename: string; buffer: Buffer; isImage?: boolean; contentType?: string }> = [];
    const skipped: SkippedUploadLink[] = [];
    const effectiveWatermarks = this.watermarkEnabled === false
      ? []
      : resolveWatermarkList(
          this.watermarks,
          watermarks,
          this.watermark,
          watermark,
          this.watermarkSecondary,
          watermarkSecondary,
        );
    for (const u of uploads) {
      try {
        let buf: Buffer;
        let resolvedUrl = u.url;
        let removalAttempted = Boolean(u.watermarkRemovalState?.attempted);
        let removalFailed = Boolean(u.watermarkRemovalState?.failed);
        if (u.isImage && resolvedUrl && u.watermarkRemoval && !u.watermarkRemovalState) {
          removalAttempted = true;
          try {
            resolvedUrl = await removeWatermarkFromImageUrl(resolvedUrl, u.watermarkRemoval);
          } catch (error: any) {
            removalFailed = true;
            console.error(`[去水印] 处理失败，回退原图并跳过新水印: ${u.filename} ${String(error?.message || error)}`);
            resolvedUrl = u.url;
          }
        }
        if (u.localPath) {
          buf = await this.readLocalFile(u.localPath);
        } else if (resolvedUrl) {
          if (resolvedUrl.startsWith("file://")) {
            buf = await this.readLocalFile(fileURLToPath(resolvedUrl));
          } else if (path.isAbsolute(resolvedUrl)) {
            buf = await this.readLocalFile(resolvedUrl);
          } else {
            buf = await this.downloadUrl(resolvedUrl);
          }
        } else {
          continue;
        }
        const isImageLike = Boolean(u.isImage || looksLikeImage(buf));
        const isVideoLike = Boolean(u.isVideo || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(u.filename || ""));
        const shouldWatermark = shouldApplyWatermarkAfterRemoval({
          hasWatermarks: effectiveWatermarks.length > 0,
          isImage: isImageLike,
          removalAttempted,
          removalFailed,
        });
        let finalBuffer = buf;
        if (u.watermarkCover && isImageLike && u.watermarkCover.applyToImages !== false) {
          finalBuffer = await applyWatermarkCoverToImageBuffer(finalBuffer, u.watermarkCover);
        } else if (u.watermarkCover && isVideoLike && u.watermarkCover.applyToVideos === true) {
          try {
            finalBuffer = await applyWatermarkCoverToVideoBuffer(finalBuffer, u.filename, u.watermarkCover);
          } catch (error: any) {
            console.error(`[色块遮挡] 视频处理失败，保留原视频: ${u.filename} ${String(error?.message || error)}`);
          }
        }
        if (shouldWatermark) {
          const beforeWatermark = finalBuffer;
          finalBuffer = await applyWatermarksToBuffer(finalBuffer, effectiveWatermarks);
          if (finalBuffer !== beforeWatermark) {
            console.log(
              `[水印] 已处理图片: ${u.filename} (${formatSize(beforeWatermark.length)} -> ${formatSize(finalBuffer.length)})`,
            );
          } else {
            console.log(`[水印] 图片未发生变化: ${u.filename}`);
          }
        } else if (removalAttempted && removalFailed && effectiveWatermarks.length > 0 && isImageLike) {
          console.warn(`[水印] 已跳过追加新水印: ${u.filename}（原因：去水印失败）`);
        }
        const normalizedFile = normalizeUploadFileDescriptor(u.filename, finalBuffer);
        results.push({
          filename: normalizedFile.filename,
          buffer: finalBuffer,
          isImage: isImageLike,
          contentType: normalizedFile.contentType,
        });
      } catch (error: any) {
        const message = String(error?.message || error);
        const size = parseOversizedBytes(message);
        const hasLink = typeof u.url === "string" && u.url.trim();
        if (!hasLink && size === undefined && !/exceeded size limit|download timeout|too large/i.test(message)) {
          throw error;
        }
        skipped.push({
          filename: u.filename || "attachment",
          url: hasLink ? u.url : undefined,
          size,
          reason: size || /too large|exceeded size limit/i.test(message) ? "超过 Discord 上传限制" : "附件下载失败",
        });
        console.warn(`[SenderBot] 附件跳过上传，改为链接: ${u.filename} ${message}`);
      }
    }
    return { files: results, skipped };
  }

  private async readLocalFile(filePath: string): Promise<Buffer> {
    const resolvedPath = filePath.startsWith("file://") ? fileURLToPath(filePath) : filePath;
    const stat = await fs.stat(resolvedPath);
    if (stat.size > MAX_UPLOAD_SIZE) {
      throw new Error(`File too large (${stat.size} bytes)`);
    }
    return await fs.readFile(resolvedPath);
  }

  private async downloadUrl(fileUrl: string): Promise<Buffer> {
    const u = new URL(fileUrl);
    const options: https.RequestOptions = {
      method: "GET",
      hostname: u.hostname,
      path: u.pathname + u.search,
      agent: this.httpAgent as any,
      timeout: DOWNLOAD_TIMEOUT_MS
    };
    return await new Promise<Buffer>((resolve, reject) => {
      const req = https.request(options, (res) => {
        // 检查 Content-Length (如果有)
        const sizeStr = res.headers['content-length'];
        if (sizeStr && parseInt(sizeStr) > MAX_UPLOAD_SIZE) {
          req.destroy();
          return reject(new Error(`File too large (${sizeStr} bytes)`));
        }

        const chunks: Buffer[] = [];
        let total = 0;
        
        res.on("data", (d: Buffer) => {
          total += d.length;
          if (total > MAX_UPLOAD_SIZE) {
            req.destroy();
            reject(new Error("File download exceeded size limit"));
            return;
          }
          chunks.push(d);
        });
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      });
      
      req.on("error", reject);
      req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
        req.destroy(new Error("Download timeout"));
      });
      req.end();
    });
  }

  async prepare() {
    if (this.hasDirectChannelTarget()) {
      this.defaultChannelId = this.targetChannelId;
      return;
    }
    // 读取 webhook 元信息，拿到 guild_id、默认 channel_id 和名称
    try {
      const info = await this.getWebhookInfo();
      this.webhookGuildId = info.guild_id;
      this.defaultChannelId = info.channel_id;
      this.webhookName = info.name; // 保存 webhook 名称
      
      // 如果启用机器人中转但没有 channel_id，记录警告
      if (this.enableBotRelay && !this.defaultChannelId) {
        console.warn(`[SenderBot] 警告: 启用机器人中转但无法获取 channel_id，机器人中转可能无法工作`);
      }
    } catch (e: any) {
      // 如果启用机器人中转，记录错误
      if (this.enableBotRelay) {
        console.error(`[SenderBot] 获取 webhook 信息失败，机器人中转可能无法工作: ${String(e?.message || e)}`);
      }
      // 忽略失败，不影响基本发送（webhook 模式）
    }
  }

  /**
   * 统计中英文占比，返回中文比例与英文比例
   */
  private languageStats(text: string): { chineseRatio: number; englishRatio: number } {
    if (!text) return { chineseRatio: 0, englishRatio: 0 };
    const chars = Array.from(text);
    let cn = 0;
    let en = 0;
    for (const ch of chars) {
      if (/[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]/u.test(ch)) cn++;
      else if (/[A-Za-z]/.test(ch)) en++;
    }
    const total = cn + en || 1;
    return { chineseRatio: cn / total, englishRatio: en / total };
  }

  /**
   * 判断是否需要翻译以及目标语言
   * - 中文占比 > 0.5：不翻译
   * - 英文占比 >= 0.5：翻译成中文
   * - 中英混合：按占比，中文多则翻译成英文，英文多则翻译成中文
   * - 都很少：不翻译
   */
  public chooseTranslateTarget(text: string): "zh" | "en" | null {
    const { chineseRatio, englishRatio } = this.languageStats(text);
    if (chineseRatio > 0.5) return null;
    if (englishRatio >= 0.5) return "zh";
    if (chineseRatio === 0 && englishRatio === 0) return null;
    if (chineseRatio > englishRatio) return "en";
    if (englishRatio > chineseRatio) return "zh";
    return null;
  }

  /**
   * 调用翻译 API 进行翻译（支持多个翻译服务）
   */
  public async translateText(text: string, target: "zh" | "en" | "zh-en" | "en-zh"): Promise<string | null> {
    if (!text || text.length < 2) {
      return null; // 忽略太短的
    }
    
    // 忽略纯 URL
    if (/^https?:\/\/[^\s]+$/.test(text.trim())) {
      return null;
    }
    
    const apiKey = this.translationApiKey || this.deepseekApiKey;
    if (!apiKey) {
      return null;
    }

    // 确定最终目标语言
    let finalTarget: "zh" | "en";
    if (target === "zh-en") {
      finalTarget = "en";
      console.log(`[翻译] 强制中译英: "${text.substring(0, 50)}..." -> 英文`);
    } else if (target === "en-zh") {
      finalTarget = "zh";
      console.log(`[翻译] 强制英译中: "${text.substring(0, 50)}..." -> 中文`);
    } else {
      finalTarget = target;
    }

    // 如果是强制翻译方向（zh-en 或 en-zh），则强制翻译，不检查语言统计
    // 如果是自动检测（zh 或 en），则检查语言统计
    if (target === "zh" || target === "en") {
      // 只处理中英互译，其他语言不翻译
      const { chineseRatio, englishRatio } = this.languageStats(text);
      if (chineseRatio === 0 && englishRatio === 0) {
        console.log(`[翻译] 跳过：文本不包含中英文`);
        return null;
      }
      // 对于自动检测，如果文本已经是目标语言，则不翻译
      if (target === "zh" && chineseRatio > 0.5) {
        console.log(`[翻译] 跳过：文本主要是中文，不需要翻译成中文`);
        return null; // 文本主要是中文，不需要翻译成中文
      }
      if (target === "en" && englishRatio >= 0.5) {
        console.log(`[翻译] 跳过：文本主要是英文，不需要翻译成英文`);
        return null; // 文本主要是英文，不需要翻译成英文
      }
    }
    // 对于强制翻译方向（zh-en 或 en-zh），无论文本是什么语言都强制翻译

    const provider = this.translationProvider || "deepseek";
    
    try {
      switch (provider) {
        case "deepseek":
        case "openai":
          return await this.translateWithAI(provider, apiKey, text, finalTarget);
        case "google":
          return await this.translateWithGoogle(apiKey, text, finalTarget);
        case "baidu":
          return await this.translateWithBaidu(apiKey, this.translationSecret || "", text, finalTarget);
        case "youdao":
          return await this.translateWithYoudao(apiKey, this.translationSecret || "", text, finalTarget);
        default:
          console.error(`[翻译] 不支持的翻译服务: ${provider}`);
          return null;
      }
    } catch (e) {
      console.error("[翻译] 异常:", e);
      return null;
    }
  }

  private async translateWithAI(provider: "deepseek" | "openai", apiKey: string, text: string, target: "zh" | "en"): Promise<string | null> {
    const baseUrl = (this.translationBaseUrl || (provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com")).replace(/\/+$/, "");
    const model = this.translationModel || (provider === "deepseek" ? "deepseek-chat" : "gpt-4o-mini");
    const url = new URL(`${baseUrl}/v1/chat/completions`);
    const defaultPrompt =
      target === "zh"
        ? "You are a translator. Translate the given text into Simplified Chinese. Preserve punctuation, numbers, links, emojis, and spacing. Return only the translated result."
        : "You are a translator. Translate the given text into English. Preserve punctuation, numbers, links, emojis, and spacing. Return only the translated result.";
    const prompt = this.translationPrompt?.trim() || defaultPrompt;
    
      const payload = JSON.stringify({
      model,
        messages: [
          {
            role: "system",
          content: prompt
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
        "Authorization": `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload)
        },
        agent: this.httpAgent as any
      };

    return await new Promise<string | null>((resolve) => {
        const req = https.request(options, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const json = body ? JSON.parse(body) : null;
                const translatedText = json?.choices?.[0]?.message?.content?.trim();
                if (translatedText) {
                console.log(`[翻译] ${provider} 翻译成功`);
                  resolve(translatedText);
                } else {
                console.log(`[翻译] ${provider} API 返回格式异常`);
                  resolve(null);
                }
              } catch (e) {
              console.error(`[翻译] ${provider} 解析响应失败:`, e);
              resolve(null);
            }
          } else {
            console.error(`[翻译] ${provider} API 请求失败: HTTP ${res.statusCode}`);
            resolve(null);
          }
        });
      });
      req.setTimeout(60000, () => {
        req.destroy();
        console.error(`[翻译] ${provider} 请求超时`);
        resolve(null);
      });
      req.on("error", (err) => {
        console.error(`[翻译] ${provider} 网络错误:`, err);
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
  }

  private async translateWithGoogle(apiKey: string, text: string, target: "zh" | "en"): Promise<string | null> {
    // Google Translate API v2 (需要付费)
    const targetLang = target === "zh" ? "zh-CN" : "en";
    const url = new URL(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`);
    
    const payload = JSON.stringify({
      q: text,
      target: targetLang,
      format: "text"
    });

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

    return await new Promise<string | null>((resolve) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = body ? JSON.parse(body) : null;
              const translatedText = json?.data?.translations?.[0]?.translatedText;
              if (translatedText) {
                console.log(`[翻译] Google 翻译成功`);
                resolve(translatedText);
              } else {
                resolve(null);
              }
            } catch (e) {
              console.error(`[翻译] Google 解析响应失败:`, e);
              resolve(null);
            }
          } else {
            console.error(`[翻译] Google API 请求失败: HTTP ${res.statusCode}`);
            resolve(null);
          }
        });
      });
      req.setTimeout(60000, () => {
          req.destroy();
        console.error("[翻译] Google 请求超时");
        resolve(null);
        });
        req.on("error", (err) => {
        console.error("[翻译] Google 网络错误:", err);
        resolve(null);
        });
        req.write(payload);
        req.end();
      });
  }

  private async translateWithBaidu(appId: string, secretKey: string, text: string, target: "zh" | "en"): Promise<string | null> {
    // 百度翻译 API
    const crypto = require("crypto");
    const salt = Date.now().toString();
    const from = target === "zh" ? "en" : "zh";
    const to = target === "zh" ? "zh" : "en";
    const sign = crypto.createHash("md5").update(appId + text + salt + secretKey).digest("hex");
    
    const url = new URL("https://fanyi-api.baidu.com/api/trans/vip/translate");
    url.searchParams.set("q", text);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("appid", appId);
    url.searchParams.set("salt", salt);
    url.searchParams.set("sign", sign);

    const options: https.RequestOptions = {
      method: "GET",
      hostname: url.hostname,
      path: url.pathname + url.search,
      agent: this.httpAgent as any
    };

    return await new Promise<string | null>((resolve) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = body ? JSON.parse(body) : null;
              const translatedText = json?.trans_result?.[0]?.dst;
              if (translatedText) {
                console.log(`[翻译] 百度翻译成功`);
                resolve(translatedText);
              } else {
                resolve(null);
              }
            } catch (e) {
              console.error(`[翻译] 百度解析响应失败:`, e);
              resolve(null);
            }
          } else {
            console.error(`[翻译] 百度 API 请求失败: HTTP ${res.statusCode}`);
            resolve(null);
          }
        });
      });
      req.setTimeout(60000, () => {
        req.destroy();
        console.error("[翻译] 百度请求超时");
        resolve(null);
      });
      req.on("error", (err) => {
        console.error("[翻译] 百度网络错误:", err);
        resolve(null);
      });
      req.end();
    });
  }

  private async translateWithYoudao(appKey: string, appSecret: string, text: string, target: "zh" | "en"): Promise<string | null> {
    // 有道翻译 API
    const crypto = require("crypto");
    const salt = Date.now().toString();
    const from = target === "zh" ? "EN" : "zh-CHS";
    const to = target === "zh" ? "zh-CHS" : "EN";
    const curtime = Math.round(Date.now() / 1000).toString();
    const signStr = appKey + (text.length > 20 ? text.substring(0, 10) + text.length + text.substring(text.length - 10) : text) + salt + curtime + appSecret;
    const sign = crypto.createHash("sha256").update(signStr).digest("hex");
    
    const url = new URL("https://openapi.youdao.com/api");
    const payload = new URLSearchParams({
      q: text,
      from: from,
      to: to,
      appKey: appKey,
      salt: salt,
      sign: sign,
      signType: "v3",
      curtime: curtime
    });

    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload.toString())
      },
      agent: this.httpAgent as any
    };

    return await new Promise<string | null>((resolve) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = body ? JSON.parse(body) : null;
              const translatedText = json?.translation?.[0];
              if (translatedText && json.errorCode === "0") {
                console.log(`[翻译] 有道翻译成功`);
                resolve(translatedText);
              } else {
                resolve(null);
              }
    } catch (e) {
              console.error(`[翻译] 有道解析响应失败:`, e);
              resolve(null);
            }
          } else {
            console.error(`[翻译] 有道 API 请求失败: HTTP ${res.statusCode}`);
            resolve(null);
          }
        });
      });
      req.setTimeout(60000, () => {
        req.destroy();
        console.error("[翻译] 有道请求超时");
        resolve(null);
      });
      req.on("error", (err) => {
        console.error("[翻译] 有道网络错误:", err);
        resolve(null);
      });
      req.write(payload.toString());
      req.end();
    });
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
    uploads?: Array<{
      url?: string;
      localPath?: string;
      filename: string;
      isImage?: boolean;
      isVideo?: boolean;
      watermarkRemoval?: WatermarkRemovalConfig;
      watermarkRemovalState?: WatermarkRemovalRuntimeState;
      watermarkCover?: WatermarkCoverConfig;
    }>;
    components?: any[];
    // 可选：覆盖当前消息是否启用翻译；未设置则沿用实例级 enableTranslation
    enableTranslationOverride?: boolean;
    // 可选：覆盖翻译方向
    translationDirection?: "auto" | "zh-en" | "en-zh" | "off";
    // 可选：规则级别的替换字典
    ruleReplacementsDictionary?: Record<string, string>;
    stripEnglish?: boolean;
    stripChinese?: boolean;
    // 可选：规则级别水印配置
    watermark?: WatermarkConfig;
    watermarkSecondary?: WatermarkConfig;
    watermarks?: WatermarkConfig[];
  }>) {
    if (messagesToSend.length == 0) return;

    const results: Array<{
      sourceMessageId?: string;
      targetMessageId: string;
      targetChannelId: string;
    }> = [];

    // 并行处理所有消息的翻译和准备（提升并发性能）
    // 注意：分片消息的分片之间仍需保持顺序，但不同消息可以并行
    const processedMessages = await Promise.all(
      messagesToSend.map(async (item) => {
      let text = String(applyReplacementDictionary(item.content || "", this.replacementsDictionary));
      text = String(applyReplacementDictionary(text, item.ruleReplacementsDictionary));
      const replacedExtraEmbeds = applyReplacementDictionaryToEmbeds(
        applyReplacementDictionaryToEmbeds(item.extraEmbeds, this.replacementsDictionary),
        item.ruleReplacementsDictionary,
      );

        // 如果启用了翻译，尝试翻译文本；已含分隔线视为已翻译，跳过
        const alreadyTranslated = text.includes("\n---\n");
        const enableForThis =
          typeof item.enableTranslationOverride === "boolean"
            ? item.enableTranslationOverride
            : this.enableTranslation;
        // 如果翻译方向为 "off"，则不翻译
        let targetLang: "zh" | "en" | "zh-en" | "en-zh" | null = null;
        if (!alreadyTranslated && enableForThis && item.translationDirection !== "off") {
          if (item.translationDirection && item.translationDirection !== "auto") {
            // 强制翻译方向
            targetLang = item.translationDirection;
            console.log(`[翻译] 使用强制翻译方向: ${targetLang}`);
          } else {
            // 自动检测
            targetLang = this.chooseTranslateTarget(text);
            if (targetLang) {
              console.log(`[翻译] 自动检测翻译方向: ${targetLang}`);
            }
          }
        }
        if (!alreadyTranslated && targetLang && text.trim()) {
          const translated = await this.translateText(text, targetLang);
        if (translated) {
            // 原文在上，分割线，中间保持紧凑
            text = `${text}\n---\n${translated}`;
            console.log(`[翻译] 翻译成功: ${targetLang}`);
        } else {
            console.log(`[翻译] 翻译失败或跳过: ${targetLang}`);
        }
      }

      if (item.stripEnglish || item.stripChinese) {
        text = stripLanguages(text, {
          stripEnglish: item.stripEnglish,
          stripChinese: item.stripChinese,
        });
      }

      // Discord limits: content 2000, embed.description 4096
      const MESSAGE_CHUNK = item.useEmbed ? 4096 : 2000;
      // 判断是否只有 embeds：无论 useEmbed 是否为 true，只要有 extraEmbeds 且没有文本内容，就认为是 only embeds
      const hasOnlyEmbeds = (item.extraEmbeds?.length || 0) > 0 && text.trim() === "";
      const hasUploads = (item.uploads?.length || 0) > 0;
        if (text.trim() === "" && !hasOnlyEmbeds && !hasUploads) {
          return null; // 跳过空消息
        }

        // 计算分片数量
      const loopCount = Math.max(1, hasOnlyEmbeds ? 1 : Math.ceil(text.length / MESSAGE_CHUNK));
        
        return {
          item,
          text,
          replacedExtraEmbeds,
          loopCount,
          hasUploads,
          hasOnlyEmbeds,
          MESSAGE_CHUNK,
        };
      })
    );

    // 过滤掉空消息，然后并行发送所有消息
    // 注意：如果消息有回复关系，Discord API 会自动处理，不需要等待
    const sendPromises = processedMessages
      .filter((msg): msg is NonNullable<typeof msg> => msg !== null)
      .map(async (processed) => {
        const { item, text, replacedExtraEmbeds, loopCount, hasUploads, hasOnlyEmbeds, MESSAGE_CHUNK } = processed;
        const itemResults: Array<{
          sourceMessageId?: string;
          targetMessageId: string;
          targetChannelId: string;
        }> = [];

        const sendPreparedPayload = async (
          payload: any,
          files: Array<{ filename: string; buffer: Buffer; isImage?: boolean; contentType?: string }>,
          hasFileUpload: boolean,
        ) => {
          if (this.hasDirectChannelTarget()) {
            return await this.postDirectMessage(payload, files);
          }
          if (this.enableBotRelay && this.botRelayToken && this.defaultChannelId) {
            console.log(
              hasFileUpload
                ? `[SenderBot] 使用 Bot API 发送消息（带附件）`
                : `[SenderBot] 使用 Bot API 发送消息 (enableBotRelay=${this.enableBotRelay})`,
            );
            return await this.postViaBotAPI(payload, files, this.defaultChannelId);
          }
          if (this.enableBotRelay) {
            if (!this.botRelayToken) {
              console.warn(`[SenderBot] 机器人中转已启用但 botRelayToken 未配置，回退到 webhook 模式`);
            } else if (!this.defaultChannelId) {
              console.warn(`[SenderBot] 机器人中转已启用但 defaultChannelId 未设置，回退到 webhook 模式`);
            }
          }
          if (hasFileUpload) {
            console.log(`[SenderBot] 使用 Webhook 发送消息（带附件）(enableBotRelay=${this.enableBotRelay}, username=${payload.username || 'none'}, avatarUrl=${payload.avatar_url ? 'yes' : 'no'})`);
            return await this.postMultipart(payload, files, true);
          }
          console.log(`[SenderBot] 使用 Webhook 发送消息 (enableBotRelay=${this.enableBotRelay}, username=${payload.username || 'none'}, avatarUrl=${payload.avatar_url ? 'yes' : 'no'})`);
          return await this.postToWebhook(payload, true);
        };

        // 分片消息的分片之间需要保持顺序（因为回复关系）
      for (let idx = 0; idx < loopCount; idx++) {
        const i = idx * MESSAGE_CHUNK;
        const chunk = text.substring(i, i + MESSAGE_CHUNK);
        let resp: any = null;
          
        const sendUploadsWithThisChunk = hasUploads && idx === 0;

        if (sendUploadsWithThisChunk) {
          // Build multipart form with files and payload_json
          const { files, skipped } = await this.downloadUploads(
            item.uploads!,
            item.watermark,
            item.watermarkSecondary,
            item.watermarks,
          );
          const chunkWithSkippedLinks = appendSkippedUploadLinks(chunk || "", skipped);
          const desc = chunkWithSkippedLinks.slice(0, 4096);
          const embed: any = {};
          if (item.useEmbed && desc.trim() !== "") {
            embed.description = desc;
          }
          const firstImage = files.find((f) => f.isImage);
          if (item.useEmbed && firstImage) {
            embed.image = { url: `attachment://${firstImage.filename}` };
          }
          const payload: any = {
            content: item.useEmbed ? "" : chunkWithSkippedLinks.trim() || " ",
            allowed_mentions: { parse: [], replied_user: false },
          };
          if (item.useEmbed && Object.keys(embed).length > 0) {
            payload.embeds = [embed, ...((replacedExtraEmbeds as any[]) || [])];
          } else if (replacedExtraEmbeds && replacedExtraEmbeds.length > 0) {
            payload.embeds = replacedExtraEmbeds;
          }
          // Bot API不支持username和avatar_url，只在webhook模式下使用
          const useWebhookMode = !this.enableBotRelay && !this.hasDirectChannelTarget();

          if (useWebhookMode) {
          const webhookIdentity = resolveWebhookIdentity(
            item.username,
            item.avatarUrl,
            this.targetWebhookName,
            this.targetWebhookAvatarUrl,
          );
          if (webhookIdentity.username) payload.username = webhookIdentity.username;
          if (webhookIdentity.avatarUrl) payload.avatar_url = webhookIdentity.avatarUrl;
          }
          
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
          
          resp = await sendPreparedPayload(payload, files, files.length > 0);
        } else {
          const payload: any = {
            allowed_mentions: { parse: [], replied_user: false }
          };
          if (item.useEmbed) {
            payload.content = "";
            const base = chunk ? [{ description: chunk }] : [];
              let embeds: any[] = [...base, ...((replacedExtraEmbeds as any[]) || [])];

              // 翻译 embed 字段（中英互译，非中英不翻译）
              const enableEmbedTranslation =
                typeof item.enableTranslationOverride === "boolean"
                  ? item.enableTranslationOverride
                  : this.enableTranslation;
              // 如果翻译方向为 "off"，则不翻译 embed
              if (enableEmbedTranslation && item.translationDirection !== "off" && embeds.length > 0) {
                const formatTranslated = (orig: string, t?: string | null) => {
                  if (!t || t.trim() === orig.trim()) return orig;
                  return `${orig}\n---\n${t}`;
                };
                embeds = await Promise.all(
                  embeds.map(async (e: any) => {
                    const translateField = async (txt?: string) => {
                      if (!txt) return txt;
                      if (txt.includes("\n---\n")) return txt;
                      // 如果翻译方向为 "off"，则不翻译
                      if (item.translationDirection === "off") return txt;
                      const target = item.translationDirection && item.translationDirection !== "auto"
                        ? item.translationDirection
                        : this.chooseTranslateTarget(txt);
                      if (!target) return txt;
                      const t = await this.translateText(txt, target);
                      return formatTranslated(txt, t || undefined);
                    };
                    return {
                      ...e,
                      title: await translateField(e.title),
                      description: await translateField(e.description),
                      footer: e.footer ? { ...e.footer, text: await translateField(e.footer.text) } : e.footer,
                      author: e.author ? { ...e.author, name: await translateField(e.author.name) } : e.author,
                      fields: e.fields
                        ? await Promise.all(
                            e.fields.map(async (f: any) => ({
                              ...f,
                              name: await translateField(f.name),
                              value: await translateField(f.value),
                            }))
                          )
                        : e.fields,
                    };
                  })
                );
              }

              payload.embeds = embeds;
          } else {
            // useEmbed 为 false 的情况：设置文本内容，如果有 extraEmbeds 也一并添加
            payload.content = chunk || ""; // 即使 chunk 为空也设置为空字符串，避免 undefined
            if (replacedExtraEmbeds && replacedExtraEmbeds.length > 0) {
              // 如果有 extraEmbeds，即使 content 为空也要发送（允许只有 embeds 的消息）
              payload.embeds = replacedExtraEmbeds;
              // 如果 content 为空但有 embeds，确保 content 至少是空字符串（Discord API 要求）
              if (!payload.content || payload.content.trim() === "") {
                payload.content = "";
              }
            }
          }
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          // Bot API不支持username和avatar_url，只在webhook模式下使用
          const useWebhookMode = !this.enableBotRelay && !this.hasDirectChannelTarget();
          
          if (useWebhookMode) {
          const webhookIdentity = resolveWebhookIdentity(
            item.username,
            item.avatarUrl,
            this.targetWebhookName,
            this.targetWebhookAvatarUrl,
          );
          if (webhookIdentity.username) payload.username = webhookIdentity.username;
          if (webhookIdentity.avatarUrl) payload.avatar_url = webhookIdentity.avatarUrl;
          }
          
          if (item.replyToTarget?.messageId) {
            payload.message_reference = { message_id: item.replyToTarget.messageId, fail_if_not_exists: false };
          }
          
          resp = await sendPreparedPayload(payload, [], false);
        }
          
        if (resp?.id && resp?.channel_id) {
            itemResults.push({
            sourceMessageId: i === 0 ? item.sourceMessageId : undefined,
            targetMessageId: String(resp.id),
            targetChannelId: String(resp.channel_id)
          });
        }
      }
        
        return itemResults;
      });

    // 等待所有消息发送完成，并收集结果
    const allResults = await Promise.all(sendPromises);
    for (const itemResults of allResults) {
      results.push(...itemResults);
    }

    return results;
  }

  async editForwardedMessage(params: {
    targetChannelId: string;
    targetMessageId: string;
    content: string;
    useEmbed?: boolean;
    extraEmbeds?: any[];
    components?: any[];
    enableTranslationOverride?: boolean;
    translationDirection?: "auto" | "zh-en" | "en-zh" | "off";
    ruleReplacementsDictionary?: Record<string, string>;
    stripEnglish?: boolean;
    stripChinese?: boolean;
  }) {
    let text = String(applyReplacementDictionary(params.content || "", this.replacementsDictionary));
    text = String(applyReplacementDictionary(text, params.ruleReplacementsDictionary));
    const replacedExtraEmbeds = applyReplacementDictionaryToEmbeds(
      applyReplacementDictionaryToEmbeds(params.extraEmbeds, this.replacementsDictionary),
      params.ruleReplacementsDictionary,
    );

    const alreadyTranslated = text.includes("\n---\n");
    const enableForThis =
      typeof params.enableTranslationOverride === "boolean"
        ? params.enableTranslationOverride
        : this.enableTranslation;

    let targetLang: "zh" | "en" | "zh-en" | "en-zh" | null = null;
    if (!alreadyTranslated && enableForThis && params.translationDirection !== "off") {
      if (params.translationDirection && params.translationDirection !== "auto") {
        targetLang = params.translationDirection;
      } else {
        targetLang = this.chooseTranslateTarget(text);
      }
    }
    if (!alreadyTranslated && targetLang && text.trim()) {
      const translated = await this.translateText(text, targetLang);
      if (translated) {
        text = `${text}\n---\n${translated}`;
      }
    }

    if (params.stripEnglish || params.stripChinese) {
      text = stripLanguages(text, {
        stripEnglish: params.stripEnglish,
        stripChinese: params.stripChinese,
      });
    }

    const payload: any = {
      allowed_mentions: { parse: [], replied_user: false },
    };

    if (params.useEmbed) {
      payload.content = "";
      const base = text ? [{ description: text.slice(0, 4096) }] : [];
      let embeds: any[] = [...base, ...((replacedExtraEmbeds as any[]) || [])];

      if (enableForThis && params.translationDirection !== "off" && embeds.length > 0) {
        const formatTranslated = (orig: string, t?: string | null) => {
          if (!t || t.trim() === orig.trim()) return orig;
          return `${orig}\n---\n${t}`;
        };
        embeds = await Promise.all(
          embeds.map(async (e: any) => {
            const translateField = async (txt?: string) => {
              if (!txt) return txt;
              if (txt.includes("\n---\n")) return txt;
              if (params.translationDirection === "off") return txt;
              const target =
                params.translationDirection && params.translationDirection !== "auto"
                  ? params.translationDirection
                  : this.chooseTranslateTarget(txt);
              if (!target) return txt;
              const t = await this.translateText(txt, target);
              return formatTranslated(txt, t || undefined);
            };
            return {
              ...e,
              title: await translateField(e.title),
              description: await translateField(e.description),
              footer: e.footer ? { ...e.footer, text: await translateField(e.footer.text) } : e.footer,
              author: e.author ? { ...e.author, name: await translateField(e.author.name) } : e.author,
              fields: e.fields
                ? await Promise.all(
                    e.fields.map(async (f: any) => ({
                      ...f,
                      name: await translateField(f.name),
                      value: await translateField(f.value),
                    })),
                  )
                : e.fields,
            };
          }),
        );
      }

      payload.embeds = embeds;
    } else {
      payload.content = text.slice(0, 2000);
      if (replacedExtraEmbeds && replacedExtraEmbeds.length > 0) {
        payload.embeds = replacedExtraEmbeds;
      }
    }

    if (params.components && params.components.length > 0) {
      payload.components = params.components;
    }

    const hasEmbeds = Array.isArray(payload.embeds) && payload.embeds.length > 0;
    const hasComponents = Array.isArray(payload.components) && payload.components.length > 0;
    if (!payload.content && !hasEmbeds && !hasComponents) {
      payload.content = " ";
    }

    if (this.hasDirectChannelTarget()) {
      return await this.patchDirectMessage(params.targetChannelId || this.targetChannelId || "", params.targetMessageId, payload);
    }
    if (this.enableBotRelay && this.botRelayToken && params.targetChannelId) {
      return await this.patchViaBotAPI(params.targetChannelId, params.targetMessageId, payload);
    }
    return await this.patchWebhookMessage(params.targetMessageId, payload);
  }

  async deleteForwardedMessage(params: {
    targetChannelId?: string;
    targetMessageId: string;
  }): Promise<void> {
    const targetMessageId = String(params.targetMessageId || "").trim();
    if (!targetMessageId) {
      throw new Error("Discord delete target message id is not configured");
    }

    if (this.hasDirectChannelTarget()) {
      const channelId = params.targetChannelId || this.targetChannelId || "";
      await this.deleteDiscordChannelMessage(channelId, targetMessageId, this.buildDiscordAuthorizationHeader());
      return;
    }
    if (this.enableBotRelay && this.botRelayToken && params.targetChannelId) {
      await this.deleteDiscordChannelMessage(params.targetChannelId, targetMessageId, `Bot ${this.botRelayToken}`);
      return;
    }
    await this.deleteWebhookMessage(targetMessageId);
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
      req.setTimeout(30000, () => {
        req.destroy(new Error("Webhook request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async patchWebhookMessage(messageId: string, body: Record<string, any>): Promise<any> {
    const url = new URL(this.webhookUrl);
    const safeMessageId = encodeURIComponent(messageId);
    const payload = JSON.stringify(body);

    const options: https.RequestOptions = {
      method: "PATCH",
      hostname: url.hostname,
      path: `${url.pathname}/messages/${safeMessageId}${url.search}`,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      agent: this.httpAgent as any,
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(responseBody ? JSON.parse(responseBody) : null);
            } catch {
              resolve(null);
            }
          } else {
            reject(
              new Error(
                `Webhook edit failed with status ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`,
              ),
            );
          }
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error("Webhook edit request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async patchViaBotAPI(channelId: string, messageId: string, body: Record<string, any>): Promise<any> {
    if (!this.botRelayToken) {
      throw new Error("Bot relay token is not configured");
    }

    const safeChannelId = encodeURIComponent(channelId);
    const safeMessageId = encodeURIComponent(messageId);
    const url = new URL(`https://discord.com/api/v10/channels/${safeChannelId}/messages/${safeMessageId}`);
    const payload = JSON.stringify(body);

    const options: https.RequestOptions = {
      method: "PATCH",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        Authorization: `Bot ${this.botRelayToken}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      agent: this.httpAgent as any,
    };

    return await new Promise<any>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(responseBody ? JSON.parse(responseBody) : null);
            } catch {
              resolve(null);
            }
          } else {
            reject(
              new Error(
                `Bot API edit failed with status ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`,
              ),
            );
          }
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error("Bot API edit request timeout"));
      });
      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  private async deleteWebhookMessage(messageId: string): Promise<void> {
    const url = new URL(this.webhookUrl);
    const safeMessageId = encodeURIComponent(messageId);

    const options: https.RequestOptions = {
      method: "DELETE",
      hostname: url.hostname,
      path: `${url.pathname}/messages/${safeMessageId}${url.search}`,
      agent: this.httpAgent as any,
    };

    await this.deleteRequest(options, "Webhook delete");
  }

  private async deleteDiscordChannelMessage(
    channelId: string,
    messageId: string,
    authorization: string,
  ): Promise<void> {
    const safeChannelId = encodeURIComponent(String(channelId || "").trim());
    const safeMessageId = encodeURIComponent(String(messageId || "").trim());
    if (!safeChannelId || !safeMessageId) {
      throw new Error("Discord channel delete target is not configured");
    }

    const url = new URL(`https://discord.com/api/v10/channels/${safeChannelId}/messages/${safeMessageId}`);
    const options: https.RequestOptions = {
      method: "DELETE",
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        Authorization: authorization,
      },
      agent: this.httpAgent as any,
    };

    await this.deleteRequest(options, "Discord channel delete");
  }

  private async deleteRequest(options: https.RequestOptions, label: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode && ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 404)) {
            resolve();
            return;
          }
          reject(new Error(`${label} failed with status ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`));
        });
      });
      req.setTimeout(30000, () => {
        req.destroy(new Error(`${label} request timeout`));
      });
      req.on("error", (err) => reject(err));
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

  /**
   * 通过Discord Bot API发送消息（机器人中转模式）
   */
  private async postViaBotAPI(
    body: Record<string, any>,
    files: Array<{ filename: string; buffer: Buffer; contentType?: string }>,
    channelId: string,
  ): Promise<any> {
    if (!this.botRelayToken) {
      throw new Error("Bot relay token is not configured");
    }

    const url = new URL(`https://discord.com/api/v10/channels/${channelId}/messages`);

    // 如果有文件，使用multipart/form-data
    if (files.length > 0) {
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
        push(`Content-Type: ${f.contentType || "application/octet-stream"}\r\n\r\n`);
        push(f.buffer);
        push(`\r\n`);
      });

      // end boundary
      push(`--${boundary}--\r\n`);

      const payload = Buffer.concat(parts);

      const options: https.RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          "Authorization": `Bot ${this.botRelayToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.byteLength
        },
        agent: this.httpAgent as any
      };

      return await new Promise<any>((resolve, reject) => {
        const req = https.request(options, (res) => {
          let responseBody = "";
          res.on("data", (chunk) => (responseBody += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(responseBody ? JSON.parse(responseBody) : null);
              } catch {
                resolve(null);
              }
            } else {
              reject(new Error(`Bot API multipart failed ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`));
            }
          });
        });
        req.setTimeout(30000, () => {
          req.destroy(new Error("Bot API multipart request timeout"));
        });
        req.on("error", (err) => reject(err));
        req.write(payload);
        req.end();
      });
    } else {
      // 没有文件，使用JSON
      const payload = JSON.stringify(body);

      const options: https.RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          "Authorization": `Bot ${this.botRelayToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        agent: this.httpAgent as any
      };

      return await new Promise<any>((resolve, reject) => {
        const req = https.request(options, (res) => {
          let responseBody = "";
          res.on("data", (chunk) => (responseBody += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(responseBody ? JSON.parse(responseBody) : null);
              } catch {
                resolve(null);
              }
            } else {
              // 如果400且包含message_reference可能不被支持，尝试去掉后重试一次
              if (res.statusCode === 400) {
                try {
                  const parsed = JSON.parse(responseBody || "{}");
                  const hasRef = body.message_reference ? true : false;
                  if (hasRef) {
                    const retryBody = { ...body };
                    delete retryBody.message_reference;
                    this.postViaBotAPI(retryBody, [], channelId).then(resolve).catch(reject);
                    return;
                  }
                } catch (_) {
                  // ignore parse errors
                }
              }
              reject(new Error(`Bot API request failed with status ${res.statusCode}: ${res.statusMessage} ${responseBody || ""}`));
            }
          });
        });
        req.setTimeout(30000, () => {
          req.destroy(new Error("Bot API request timeout"));
        });
        req.on("error", (err) => reject(err));
        req.write(payload);
        req.end();
      });
    }
  }
}
