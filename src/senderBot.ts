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
  translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
  translationApiKey?: string;
  translationSecret?: string;
  enableBotRelay?: boolean;
  botRelayToken?: string;

  constructor(options: {
    replacementsDictionary?: Record<string, string>;
    webhookUrl: string;
    httpAgent?: unknown; // 由 proxy-agent 创建的 Agent，可选
    enableTranslation?: boolean;
    deepseekApiKey?: string;
    translationProvider?: "deepseek" | "google" | "baidu" | "youdao" | "openai";
    translationApiKey?: string;
    translationSecret?: string;
    enableBotRelay?: boolean;
    botRelayToken?: string;
  }) {
    this.replacementsDictionary = options.replacementsDictionary || {};
    this.webhookUrl = options.webhookUrl;
    this.httpAgent = options.httpAgent;
    this.enableTranslation = options.enableTranslation || false;
    this.deepseekApiKey = options.deepseekApiKey;
    this.translationProvider = options.translationProvider || "deepseek";
    this.translationApiKey = options.translationApiKey || options.deepseekApiKey;
    this.translationSecret = options.translationSecret;
    this.enableBotRelay = options.enableBotRelay || false;
    this.botRelayToken = options.botRelayToken;
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
      req.setTimeout(30000, () => {
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
    const DOWNLOAD_TIMEOUT_MS = 30000; // 30s
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
  private chooseTranslateTarget(text: string): "zh" | "en" | null {
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
  private async translateText(text: string, target: "zh" | "en"): Promise<string | null> {
    if (!this.enableTranslation) {
      console.log("[翻译] 翻译功能未启用");
      return null;
    }
    
    const apiKey = this.translationApiKey || this.deepseekApiKey;
    if (!apiKey) {
      console.log("[翻译] API Key 未配置");
      return null;
    }
    
    if (!text.trim()) {
      return null;
    }

    // 只处理中英互译，其他语言不翻译
    const { chineseRatio, englishRatio } = this.languageStats(text);
    if (chineseRatio === 0 && englishRatio === 0) {
      console.log("[翻译] 非中英内容，跳过翻译");
      return null;
    }

    const provider = this.translationProvider || "deepseek";
    
    try {
      switch (provider) {
        case "deepseek":
        case "openai":
          return await this.translateWithAI(provider, apiKey, text, target);
        case "google":
          return await this.translateWithGoogle(apiKey, text, target);
        case "baidu":
          return await this.translateWithBaidu(apiKey, this.translationSecret || "", text, target);
        case "youdao":
          return await this.translateWithYoudao(apiKey, this.translationSecret || "", text, target);
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
    const baseUrl = provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com";
    const model = provider === "deepseek" ? "deepseek-chat" : "gpt-3.5-turbo";
    const url = new URL(`${baseUrl}/v1/chat/completions`);
    
    const payload = JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            target === "zh"
              ? "You are a translator. Translate English (and English parts in mixed text) into Simplified Chinese. Preserve punctuation, numbers, links, emojis, and spacing. Keep any existing Chinese or non-English text unchanged. Return only the translated result."
              : "You are a translator. Translate Chinese (and Chinese parts in mixed text) into English. Preserve punctuation, numbers, links, emojis, and spacing. Keep any existing English or non-Chinese text unchanged. Return only the translated result."
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
    uploads?: Array<{ url: string; filename: string; isImage?: boolean; isVideo?: boolean }>;
    components?: any[];
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
      let text = item.content || "";
      for (const [a, b] of Object.entries(this.replacementsDictionary)) {
        text = text.replaceAll(a, b);
      }

        // 如果启用了翻译，尝试翻译文本；已含分隔线视为已翻译，跳过
        const alreadyTranslated = text.includes("\n---\n");
        const targetLang = !alreadyTranslated && this.enableTranslation ? this.chooseTranslateTarget(text) : null;
        if (!alreadyTranslated && targetLang && text.trim()) {
          const translated = await this.translateText(text, targetLang);
        if (translated) {
            // 原文在上，分割线，中间保持紧凑
            text = `${text}\n---\n${translated}`;
        }
      }

      // Discord limits: content 2000, embed.description 4096
      const MESSAGE_CHUNK = item.useEmbed ? 4096 : 2000;
      const hasOnlyEmbeds = item.useEmbed === true && (item.extraEmbeds?.length || 0) > 0 && text.trim() === "";
      const hasUploads = (item.uploads?.length || 0) > 0;
        if (text.trim() === "" && !hasOnlyEmbeds && !hasUploads) {
          return null; // 跳过空消息
        }

        // 计算分片数量
      const loopCount = hasUploads ? 1 : Math.max(1, hasOnlyEmbeds ? 1 : Math.ceil(text.length / MESSAGE_CHUNK));
        
        return {
          item,
          text,
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
        const { item, text, loopCount, hasUploads, hasOnlyEmbeds, MESSAGE_CHUNK } = processed;
        const itemResults: Array<{
          sourceMessageId?: string;
          targetMessageId: string;
          targetChannelId: string;
        }> = [];

        // 分片消息的分片之间需要保持顺序（因为回复关系）
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
          // Bot API不支持username和avatar_url，只在webhook模式下使用
          if (!this.enableBotRelay) {
            if (item.username) payload.username = item.username;
            if (item.avatarUrl) payload.avatar_url = item.avatarUrl;
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
          
          // 如果启用机器人中转，使用Bot API发送，否则使用webhook
          if (this.enableBotRelay && this.botRelayToken && this.defaultChannelId) {
            resp = await this.postViaBotAPI(payload, files, this.defaultChannelId);
          } else {
            resp = await this.postMultipart(payload, files, true);
          }
        } else {
          const payload: any = {
            allowed_mentions: { parse: [], replied_user: false }
          };
          if (item.useEmbed) {
            payload.content = "";
            const base = chunk ? [{ description: chunk }] : [];
              let embeds: any[] = [...base, ...((item.extraEmbeds as any[]) || [])];

              // 翻译 embed 字段（中英互译，非中英不翻译）
              if (this.enableTranslation && embeds.length > 0) {
                const formatTranslated = (orig: string, t?: string | null) => {
                  if (!t || t.trim() === orig.trim()) return orig;
                  return `${orig}\n---\n${t}`;
                };
                embeds = await Promise.all(
                  embeds.map(async (e: any) => {
                    const translateField = async (txt?: string) => {
                      if (!txt) return txt;
                      if (txt.includes("\n---\n")) return txt;
                      const target = this.chooseTranslateTarget(txt);
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
            payload.content = chunk;
          }
          if (item.components && item.components.length > 0) {
            payload.components = item.components;
          }
          // Bot API不支持username和avatar_url，只在webhook模式下使用
          if (!this.enableBotRelay) {
            if (item.username) payload.username = item.username;
            if (item.avatarUrl) payload.avatar_url = item.avatarUrl;
          }
          if (item.replyToTarget?.messageId) {
            payload.message_reference = { message_id: item.replyToTarget.messageId, fail_if_not_exists: false };
          }
          
          // 如果启用机器人中转，使用Bot API发送，否则使用webhook
          if (this.enableBotRelay && this.botRelayToken && this.defaultChannelId) {
            resp = await this.postViaBotAPI(payload, [], this.defaultChannelId);
          } else {
            resp = await this.postToWebhook(payload, true);
          }
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
  private async postViaBotAPI(body: Record<string, any>, files: Array<{ filename: string; buffer: Buffer }>, channelId: string): Promise<any> {
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
