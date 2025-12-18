import https from "node:https";
import { URL } from "node:url";

// 飞书发送负载，与原有结构保持一致，方便 Bot 复用
export interface FeishuSendPayload {
  content: string;
  username?: string;
  avatarUrl?: string;
  // Discord 附件（其中图片会被下载后上传到飞书）
  attachments?: Array<{ url: string; filename: string; isImage?: boolean }>;
  embeds?: any[];
}

export class FeishuSender {
  // 这里存储 chat_id (oc_xxx...)，前端 / 配置里填写的就是 Chat ID
  chatId: string;
  httpAgent?: any;
  private appId?: string;
  private appSecret?: string;

  // 缓存 tenant_access_token，避免每次都请求
  private static token: string = "";
  private static tokenExpire: number = 0;

  constructor(
    chatId: string,
    httpAgent?: any,
    appId?: string,
    appSecret?: string,
  ) {
    this.chatId = chatId;
    this.httpAgent = httpAgent;
    this.appId = appId || process.env.FEISHU_APP_ID || "";
    this.appSecret = appSecret || process.env.FEISHU_APP_SECRET || "";
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
  private async uploadImage(imgUrl: string, token: string): Promise<string | null> {
    try {
      // 2.1 下载图片 Buffer
      console.log(`[FeishuSender] 开始下载图片: ${imgUrl.substring(0, 80)}...`);
      const imgBuffer = await this.download(imgUrl);
      console.log(`[FeishuSender] 图片下载完成，大小: ${imgBuffer.length} bytes`);

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
      parts.push(imgBuffer);
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
    const token = await this.getToken();

    // 如果有图片，先上传所有图片获取 image_key
    const imageKeys: string[] = [];
    if (data.attachments && data.attachments.length > 0) {
      console.log(`[FeishuSender] 开始处理 ${data.attachments.length} 个附件`);
      for (const att of data.attachments) {
        // 优先使用 isImage 标志，如果没有则通过 URL/文件名后缀判断
        const target = att.url || att.filename || "";
        const isImage = att.isImage === true || (att.isImage !== false && /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(target));
        
        if (isImage) {
          console.log(`[FeishuSender] 识别为图片，开始上传: ${att.filename || 'unknown'} (${att.url.substring(0, 50)}...)`);
          try {
            const key = await this.uploadImage(att.url, token);
            if (key) {
              imageKeys.push(key);
              console.log(`[FeishuSender] 图片上传成功: ${att.filename || att.url} -> image_key: ${key.substring(0, 20)}...`);
            } else {
              console.error(`[FeishuSender] 图片上传返回空 key: ${att.filename || att.url}`);
            }
          } catch (e: any) {
            console.error(`[FeishuSender] 图片上传失败 (${att.filename || att.url}): ${String(e?.message || e)}`);
            // 继续处理其他图片，不中断整个发送流程
          }
        } else {
          console.log(`[FeishuSender] 跳过非图片附件: ${att.filename || 'unknown'}`);
        }
      }
      console.log(`[FeishuSender] 图片处理完成，成功上传 ${imageKeys.length} 张图片`);
    }

    // 构建富文本内容 Post（单一样式：头像昵称 + 内容 + embeds 描述 + 图片）
    const elements: any[] = [];

    const headerText = data.username ? `👤 ${data.username}:\n` : "";
    const bodyText = data.content || "";

    if (headerText || bodyText) {
      elements.push({ tag: "text", text: headerText + bodyText + "\n" });
    }

    // 添加 embeds 描述
    if (data.embeds) {
      for (const e of data.embeds) {
        if (e?.description) {
          elements.push({ tag: "text", text: `\n> ${e.description}` });
        }
      }
    }

    // 添加图片元素
    for (const imgKey of imageKeys) {
      elements.push({ tag: "img", image_key: imgKey });
    }

    if (elements.length === 0) return;

    const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id");
    const payload = JSON.stringify({
      receive_id: this.chatId,
      msg_type: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "Discord 转发消息",
          content: [elements],
        },
      }),
    });

    await this.request(url, payload, "POST", token);
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

