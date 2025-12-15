import https from "node:https";
import { URL } from "node:url";

export interface FeishuSendPayload {
  content: string;
  username?: string;
  avatarUrl?: string;
  attachments?: Array<{ url: string; filename: string }>;
  embeds?: any[];
}

export class FeishuSender {
  webhookUrl: string;
  httpAgent?: any;

  constructor(webhookUrl: string, httpAgent?: any) {
    this.webhookUrl = webhookUrl;
    this.httpAgent = httpAgent;
  }

  async send(data: FeishuSendPayload) {
    const elements: any[] = [];
    const contentText = data.content || "（无文本内容）";
    if (contentText) {
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: contentText,
        },
      });
    }

    if (data.embeds && data.embeds.length > 0) {
      for (const embed of data.embeds) {
        let embedText = "";
        if (embed.title) embedText += `**${embed.title}**\n`;
        if (embed.description) embedText += `${embed.description}\n`;
        if (embed.fields) {
          for (const f of embed.fields) {
            if (f.name) embedText += `• ${f.name}: `;
            if (f.value) embedText += `${f.value}\n`;
          }
        }
        if (embedText) {
          elements.push({ tag: "hr" });
          elements.push({
            tag: "div",
            text: {
              tag: "lark_md",
              content: `> ${embedText.trim().replace(/\n/g, "\n> ")}`,
            },
          });
        }
      }
    }

    if (data.attachments && data.attachments.length > 0) {
      elements.push({ tag: "hr" });
      const links = data.attachments.map((att) => `[📄 ${att.filename}](${att.url})`).join("\n");
      elements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**附件:**\n${links}`,
        },
      });
    }

    const payload = {
      msg_type: "interactive",
      card: {
        config: {
          wide_screen_mode: true,
        },
        header: {
          template: "blue",
          title: {
            content: data.username ? `${data.username} 发送的消息` : "Discord 转发",
            tag: "plain_text",
          },
        },
        elements,
      },
    };

    await this.post(payload);
  }

  private async post(body: any): Promise<any> {
    const url = new URL(this.webhookUrl);
    const payloadStr = JSON.stringify(body);
    const options: https.RequestOptions = {
      method: "POST",
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payloadStr),
      },
      agent: this.httpAgent,
    };
    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        let responseBody = "";
        res.on("data", (chunk) => (responseBody += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(responseBody ? JSON.parse(responseBody) : {});
            } catch {
              resolve({});
            }
          } else {
            console.error(`Feishu Error: ${responseBody}`);
            resolve(null);
          }
        });
      });
      req.on("error", (err) => {
        console.error("Feishu Request Error:", err);
        resolve(null);
      });
      req.write(payloadStr);
      req.end();
    });
  }
}

