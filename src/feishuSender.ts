import https from "node:https";
import { URL } from "node:url";
import { getEnv } from "./env";
import { applyWatermarksToBuffer, resolveWatermarkList } from "./watermark";
import {
  removeWatermarkFromImageUrl,
  shouldApplyWatermarkAfterRemoval,
  type WatermarkRemovalConfig,
} from "./watermarkRemoval";
import type { WatermarkConfig } from "./config";

const MASKED_SECRET = "********";

function resolveSecret(value?: string): string {
  if (!value) return "";
  if (value === MASKED_SECRET) return "";
  return value;
}

// 飞书发送负载，与原有结构保持一致，方便 Bot 复用
export interface FeishuSendPayload {
  content: string;
  username?: string;
  avatarUrl?: string;
  // Discord 附件（其中图片会被下载后上传到飞书）
  attachments?: Array<{ url: string; filename: string; isImage?: boolean; watermarkRemoval?: WatermarkRemovalConfig }>;
  embeds?: any[];
  watermark?: WatermarkConfig;
  watermarkSecondary?: WatermarkConfig;
  watermarks?: WatermarkConfig[];
}

export class FeishuSender {
  // 这里存储 chat_id (oc_xxx...)、thread_id (om_xxx...) 或 webhook URL
  target: string;
  httpAgent?: any;
  private appId?: string;
  private appSecret?: string;
  private mode?: "webhook" | "thread";
  private watermark?: WatermarkConfig;
  private watermarkSecondary?: WatermarkConfig;
  private watermarks?: WatermarkConfig[];
  private watermarkEnabled?: boolean;

  // 缓存 tenant_access_token，避免每次都请求
  private static token: string = "";
  private static tokenExpire: number = 0;

  constructor(
    target: string,
    httpAgent?: any,
    appId?: string,
    appSecret?: string,
    options?: {
      mode?: "webhook" | "thread";
      watermark?: WatermarkConfig;
      watermarkSecondary?: WatermarkConfig;
      watermarks?: WatermarkConfig[];
      watermarkEnabled?: boolean;
    },
  ) {
    const env = getEnv();
    this.target = target;
    this.httpAgent = httpAgent;
    const resolvedAppId = resolveSecret(appId);
    const resolvedAppSecret = resolveSecret(appSecret);
    this.appId = resolvedAppId || env.FEISHU_APP_ID || "";
    this.appSecret = resolvedAppSecret || env.FEISHU_APP_SECRET || "";
    this.mode = options?.mode;
    this.watermark = options?.watermark;
    this.watermarkSecondary = options?.watermarkSecondary;
    this.watermarks = options?.watermarks;
    this.watermarkEnabled = options?.watermarkEnabled;
  }

  // 1. 获取飞书 tenant_access_token（内部应用）
  private async getToken(): Promise<string> {
    if (!this.appId || !this.appSecret) {
      throw new Error("飞书 AppID / Secret 未配置，请在飞书转发规则区域或 .env 中设置");
    }

    const now = Date.now() / 1000;
    if (FeishuSender.token && FeishuSender.tokenExpire > now) {
      return FeishuSender.token;
    }

    const url = new URL("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
    const payload = JSON.stringify({
      app_id: this.appId,
      app_secret: this.appSecret,
    });

    const res: any = await this.request(url, payload, "POST");
    if (res && res.tenant_access_token) {
      FeishuSender.token = res.tenant_access_token;
      // 提前 60 秒过期，避免边界问题
      FeishuSender.tokenExpire = now + (res.expire || 3600) - 60;
      return res.tenant_access_token;
    }

    throw new Error(`飞书鉴权失败: ${JSON.stringify(res)}`);
  }

  // 2. 下载 Discord 图片并上传到飞书，获取 image_key
  private async uploadImage(
    imgUrl: string,
    token: string,
    watermark?: WatermarkConfig,
    watermarkSecondary?: WatermarkConfig,
    watermarks?: WatermarkConfig[],
    watermarkRemoval?: WatermarkRemovalConfig,
  ): Promise<string | null> {
    try {
      // 2.1 下载图片 Buffer
      let resolvedUrl = imgUrl;
      let removalAttempted = false;
      let removalFailed = false;
      if (watermarkRemoval) {
        removalAttempted = true;
        try {
          resolvedUrl = await removeWatermarkFromImageUrl(imgUrl, watermarkRemoval);
        } catch (error: any) {
          removalFailed = true;
          console.error(`[FeishuSender] 去水印失败，回退原图并跳过新水印: ${String(error?.message || error)}`);
          resolvedUrl = imgUrl;
        }
      }
      console.log(`[FeishuSender] 开始下载图片: ${resolvedUrl.substring(0, 80)}...`);
      const imgBuffer = await this.download(resolvedUrl);
      console.log(`[FeishuSender] 图片下载完成，大小: ${imgBuffer.length} bytes`);
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
      const shouldWatermark = shouldApplyWatermarkAfterRemoval({
        hasWatermarks: effectiveWatermarks.length > 0,
        isImage: true,
        removalAttempted,
        removalFailed,
      });
      const finalBuffer = shouldWatermark
        ? await applyWatermarksToBuffer(imgBuffer, effectiveWatermarks)
        : imgBuffer;
      if (!shouldWatermark && removalAttempted && removalFailed && effectiveWatermarks.length > 0) {
        console.warn("[FeishuSender] 已跳过追加新水印（原因：去水印失败）");
      }

      // 2.2 构造 multipart/form-data 上传到飞书
      const boundary = "----FeishuBoundary" + Math.random().toString(16).slice(2);
      const url = new URL("https://open.feishu.cn/open-apis/im/v1/images");

      const parts: Buffer[] = [];
      const push = (str: string) => parts.push(Buffer.from(str));

      // image_type 字段
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="image_type"\r\n\r\nmessage\r\n`);

      // image 文件字段
      push(`--${boundary}\r\n`);
      push(`Content-Disposition: form-data; name="image"; filename="discord_img.jpg"\r\n`);
      push(`Content-Type: application/octet-stream\r\n\r\n`);
      parts.push(finalBuffer);
      push(`\r\n--${boundary}--\r\n`);

      const payload = Buffer.concat(parts);

      const options: https.RequestOptions = {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": payload.byteLength,
        },
        agent: this.httpAgent,
      };

      console.log(`[FeishuSender] 开始上传图片到飞书，大小: ${payload.byteLength} bytes`);
      const res: any = await new Promise((resolve) => {
        const req = https.request(options, (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () => {
            try {
              const parsed = JSON.parse(body);
              console.log(`[FeishuSender] 飞书上传响应: code=${parsed.code}, has_image_key=${!!parsed.data?.image_key}`);
              resolve(parsed);
            } catch {
              console.error(`[FeishuSender] 飞书上传响应解析失败: ${body.substring(0, 200)}`);
              resolve({});
            }
          });
        });
        req.on("error", (e) => {
          console.error("[FeishuSender] 飞书图片上传请求错误:", e);
          resolve({});
        });
        req.write(payload);
        req.end();
      });

      if (res.code === 0 && res.data?.image_key) {
        return res.data.image_key;
      } else {
        const errorMsg = `飞书上传图片失败: code=${res.code || 'unknown'}, msg=${res.msg || 'unknown'}, error=${JSON.stringify(res.error || {})}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
      }
    } catch (e: any) {
      const errorMsg = `图片处理异常: ${String(e?.message || e)}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  // 3. 发送消息主逻辑
  async send(data: FeishuSendPayload) {
    if (this.mode === "thread") {
      return this.sendViaThread(data);
    }

    // 默认行为：target 以 http 开头则视为 webhook，否则使用 API
    const isWebhook = this.target.startsWith("http");
    return isWebhook ? this.sendViaWebhook(data) : this.sendViaAPI(data);
  }

  private buildBaseElements(data: FeishuSendPayload): any[] {
    const elements: any[] = [];
    const headerText = data.username ? `👤 ${data.username}:\n` : "";
    const bodyText = data.content || "";

    if (headerText || bodyText) {
      elements.push({ tag: "text", text: headerText + bodyText + "\n" });
    }

    if (data.embeds) {
      for (const e of data.embeds) {
        if (e?.description) {
          elements.push({ tag: "text", text: `\n> ${e.description}` });
        }
      }
    }

    return elements;
  }

  private buildPostContent(elements: any[]) {
    return {
      zh_cn: {
        content: [elements],
      },
    };
  }

  private async collectImageKeys(
    data: FeishuSendPayload,
    token: string,
    watermark?: WatermarkConfig,
    watermarkSecondary?: WatermarkConfig,
    watermarks?: WatermarkConfig[],
  ): Promise<string[]> {
    const imageKeys: string[] = [];
    if (!data.attachments || data.attachments.length === 0) return imageKeys;

    console.log(`[FeishuSender] 开始处理 ${data.attachments.length} 个附件`);
    for (const att of data.attachments) {
      const target = att.url || att.filename || "";
      const isImage = att.isImage === true || (att.isImage !== false && /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(target));

      if (isImage) {
        console.log(`[FeishuSender] 识别为图片，开始上传: ${att.filename || "unknown"} (${att.url.substring(0, 50)}...)`);
        try {
          const key = await this.uploadImage(att.url, token, watermark, watermarkSecondary, watermarks, att.watermarkRemoval);
          if (key) {
            imageKeys.push(key);
            console.log(`[FeishuSender] 图片上传成功: ${att.filename || att.url} -> image_key: ${key.substring(0, 20)}...`);
          } else {
            console.error(`[FeishuSender] 图片上传返回空 key: ${att.filename || att.url}`);
          }
        } catch (e: any) {
          console.error(`[FeishuSender] 图片上传失败 (${att.filename || att.url}): ${String(e?.message || e)}`);
        }
      } else {
        console.log(`[FeishuSender] 跳过非图片附件: ${att.filename || "unknown"}`);
      }
    }
    console.log(`[FeishuSender] 图片处理完成，成功上传 ${imageKeys.length} 张图片`);
    return imageKeys;
  }

  private async sendViaAPI(data: FeishuSendPayload) {
    const token = await this.getToken();
    const elements = this.buildBaseElements(data);
    const imageKeys = await this.collectImageKeys(
      data,
      token,
      data.watermark,
      data.watermarkSecondary,
      data.watermarks,
    );
    for (const imgKey of imageKeys) {
      elements.push({ tag: "img", image_key: imgKey });
    }

    if (elements.length === 0) return;

    const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id");
    const payload = JSON.stringify({
      receive_id: this.target,
      msg_type: "post",
      content: JSON.stringify(this.buildPostContent(elements)),
    });

    await this.request(url, payload, "POST", token);
  }

  private async sendViaThread(data: FeishuSendPayload) {
    const threadId = this.target;
    if (!threadId) {
      throw new Error("飞书 Thread ID 为空，无法转发到话题");
    }

    const token = await this.getToken();
    const elements = this.buildBaseElements(data);
    const imageKeys = await this.collectImageKeys(
      data,
      token,
      data.watermark,
      data.watermarkSecondary,
      data.watermarks,
    );
    for (const imgKey of imageKeys) {
      elements.push({ tag: "img", image_key: imgKey });
    }

    if (elements.length === 0) return;

    const url = new URL(
      `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(threadId)}/reply`,
    );
    const payload = JSON.stringify({
      msg_type: "post",
      content: JSON.stringify(this.buildPostContent(elements)),
      reply_in_thread: true,
    });

    await this.request(url, payload, "POST", token);
  }

  private async sendViaWebhook(data: FeishuSendPayload) {
    // Webhook 方式发送，更简单
    const elements: any[] = this.buildBaseElements(data);

    if (data.attachments && data.attachments.length > 0) {
      const canUploadImages = Boolean(this.appId && this.appSecret);
      if (canUploadImages) {
        try {
          const token = await this.getToken();
          const imageKeys = await this.collectImageKeys(
            data,
            token,
            data.watermark,
            data.watermarkSecondary,
            data.watermarks,
          );
          for (const imgKey of imageKeys) {
            elements.push({ tag: "img", image_key: imgKey });
          }
          const nonImageCount = data.attachments.length - imageKeys.length;
          if (nonImageCount > 0) {
            elements.push({ tag: "text", text: `\n[包含 ${nonImageCount} 个非图片附件]` });
          }
        } catch (e) {
          elements.push({ tag: "text", text: `\n[包含 ${data.attachments.length} 个附件]` });
        }
      } else {
        elements.push({ tag: "text", text: `\n[包含 ${data.attachments.length} 个附件]` });
      }
    }

    if (elements.length === 0) return;

    const url = new URL(this.target);
    const payload = JSON.stringify({
      msg_type: "post",
      content: {
        post: this.buildPostContent(elements),
      },
    });

    await this.request(url, payload, "POST");
  }

  // 4. 列出当前机器人所在的群组，帮助查看 Chat ID
  // when returnData=true 时返回 { items }，否则只打印日志
  async listGroups(returnData?: boolean): Promise<any> {
    const token = await this.getToken();
    const url = new URL("https://open.feishu.cn/open-apis/im/v1/chats?page_size=50");

    const res: any = await this.request(url, "", "GET", token);

    if (res.code === 0 && res.data?.items) {
      if (returnData) {
        return { items: res.data.items };
      }
      console.log("======== 机器人所在的群组列表 ========");
      for (const item of res.data.items) {
        console.log(`群名: ${item.name} | Chat ID: ${item.chat_id}`);
      }
      console.log("========================================");
      return { items: res.data.items };
    } else {
      const err = { error: "获取群组失败", raw: res };
      console.error(err.error, res);
      return err;
    }
  }

  // 通用 HTTP 请求
  private async request(url: URL, payload: string, method: string, token?: string): Promise<any> {
    const options: https.RequestOptions = {
      method,
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      agent: this.httpAgent,
    };
    if (token) {
      (options.headers as any).Authorization = `Bearer ${token}`;
    }

    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch {
            resolve({});
          }
        });
      });
      req.on("error", (e) => {
        console.error("Feishu Request Error", e);
        resolve({});
      });
      req.write(payload);
      req.end();
    });
  }

  // 下载辅助函数（用于从 Discord 获取图片）
  private async download(urlStr: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: "GET",
          agent: this.httpAgent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
}
