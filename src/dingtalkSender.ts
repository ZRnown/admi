import crypto from "node:crypto";
import https from "node:https";
import { URL } from "node:url";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|svg)(?:$|[?#])/i;
const MAX_MARKDOWN_IMAGES = 20;
const MAX_MARKDOWN_LENGTH = 3800;

export interface DingTalkAttachment {
  url: string;
  filename?: string;
  isImage?: boolean;
  isVideo?: boolean;
}

export interface DingTalkSendPayload {
  content: string;
  username?: string;
  attachments?: DingTalkAttachment[];
  embeds?: any[];
}

function truncateText(input: string, limit: number): string {
  if (!input || input.length <= limit) return input;
  return `${input.slice(0, Math.max(0, limit - 16))}\n\n...(内容过长已截断)`;
}

function inferIsImage(att: DingTalkAttachment): boolean {
  if (!att) return false;
  if (att.isImage === true) return true;
  const probe = `${att.url || ""} ${att.filename || ""}`;
  return IMAGE_EXT_RE.test(probe);
}

function summarizeEmbeds(embeds?: any[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (value: any) => {
    if (value === undefined || value === null) return;
    const text = String(value).trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    lines.push(text);
  };
  for (const embed of embeds || []) {
    if (!embed || typeof embed !== "object") continue;
    push((embed as any).title);
    push((embed as any).description);
    push((embed as any).footer?.text);
    const fields = Array.isArray((embed as any).fields) ? (embed as any).fields : [];
    for (const field of fields) {
      push(field?.name);
      push(field?.value);
    }
  }
  return lines;
}

export class DingTalkSender {
  target: string;
  private secret?: string;
  private httpAgent?: any;

  constructor(
    webhookUrl: string,
    options?: {
      secret?: string;
      httpAgent?: any;
    },
  ) {
    this.target = webhookUrl;
    this.secret = typeof options?.secret === "string" ? options.secret.trim() : undefined;
    this.httpAgent = options?.httpAgent;
  }

  async send(data: DingTalkSendPayload) {
    const payload = this.buildPayload(data);
    if (!payload) return;
    const url = this.buildSignedWebhookUrl();
    const res = await this.request(url, JSON.stringify(payload));
    if (typeof res?.errcode === "number" && res.errcode !== 0) {
      throw new Error(`钉钉返回错误: errcode=${res.errcode}, errmsg=${res?.errmsg || "unknown"}`);
    }
  }

  private buildSignedWebhookUrl(): URL {
    const webhook = new URL(this.target);
    const secret = this.secret;
    if (!secret) return webhook;

    const timestamp = Date.now().toString();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac("sha256", secret).update(stringToSign).digest("base64");
    webhook.searchParams.set("timestamp", timestamp);
    webhook.searchParams.set("sign", sign);
    return webhook;
  }

  private buildPayload(data: DingTalkSendPayload): { msgtype: "markdown"; markdown: { title: string; text: string } } | null {
    const lines: string[] = [];
    const mainContent = String(data.content || "").trim();

    if (data.username) {
      lines.push(`> 来源：${String(data.username).trim()}`);
    }
    if (mainContent) {
      lines.push(mainContent);
    }

    const embedLines = summarizeEmbeds(data.embeds);
    if (embedLines.length > 0) {
      const trimmed = embedLines.slice(0, 8).map((line) => `- ${line}`);
      lines.push(`#### 附加信息\n${trimmed.join("\n")}`);
    }

    const attachments = Array.isArray(data.attachments) ? data.attachments.filter((item) => !!item?.url) : [];
    const imageAttachments = attachments.filter((att) => inferIsImage(att)).slice(0, MAX_MARKDOWN_IMAGES);
    const fileAttachments = attachments.filter((att) => !inferIsImage(att));

    if (imageAttachments.length > 0) {
      const imageLines = imageAttachments.map((att, idx) => {
        const name = (att.filename || `image_${idx + 1}`).trim();
        return `![${name}](${att.url})`;
      });
      lines.push(`#### 图片\n${imageLines.join("\n")}`);
    }

    if (fileAttachments.length > 0) {
      const fileLines = fileAttachments.map((att, idx) => {
        const name = (att.filename || `file_${idx + 1}`).trim();
        return `- [${name}](${att.url})`;
      });
      lines.push(`#### 附件/媒体\n${fileLines.join("\n")}`);
    }

    const text = truncateText(lines.join("\n\n").trim(), MAX_MARKDOWN_LENGTH);
    if (!text) return null;

    const titleSource = mainContent || data.username || "Discord 转发消息";
    const title = truncateText(titleSource.replace(/\s+/g, " ").trim(), 60) || "Discord 转发消息";
    return {
      msgtype: "markdown",
      markdown: {
        title,
        text,
      },
    };
  }

  private async request(url: URL, payload: string): Promise<any> {
    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      agent: this.httpAgent,
    };

    return await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (status < 200 || status >= 300) {
            return reject(new Error(`钉钉请求失败: ${status} ${res.statusMessage || ""} ${raw}`.trim()));
          }
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
      });
      req.setTimeout(30000, () => req.destroy(new Error("钉钉请求超时")));
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }
}
