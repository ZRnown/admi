import { promises as fs } from "fs";

import nodeHttps from "https";

import nodeHttp from "http"; // 新增引入 http

import nodeUrl from "url";

export interface OCRResult {
  code: number;
  msg: string;
  data?: Array<{
    box: number[][];
    score: number;
    text: string;
  }>;
}

export class OCRClient {
  private serverUrl: string;
  private httpAgent?: any;

  constructor(serverUrl: string, httpAgent?: any) {
    this.serverUrl = serverUrl.replace(/\/$/, "").replace('localhost', '127.0.0.1'); // 移除末尾斜杠，使用127.0.0.1
    this.httpAgent = httpAgent;
  }

  /**
   * 识别图片中的文字
   * @param imageUrl Discord图片URL
   * @returns OCR识别结果
   */
  async recognizeImage(imageUrl: string): Promise<OCRResult | null> {
    try {
      console.log(`[OCR] 开始识别图片: ${imageUrl.substring(0, 80)}...`);

      console.log(`[OCR] 步骤1: 下载图片...`);
      const imageBuffer = await this.downloadImage(imageUrl);
      console.log(`[OCR] 图片下载完成，大小: ${imageBuffer.length} bytes`);

      console.log(`[OCR] 步骤2: 调用OCR服务器 ${this.serverUrl}...`);
      const result = await this.callOCRAPI(imageBuffer);

      const textCount = result?.data?.length || 0;
      console.log(`[OCR] 识别完成，检测到 ${textCount} 个文本块`);

      if (result?.data && result.data.length > 0) {
        const allText = result.data.map(item => item.text).join(' ');
        console.log(`[OCR] 识别到的文字: "${allText.substring(0, 200)}${allText.length > 200 ? '...' : ''}"`);
      }

      return result;
    } catch (error: any) {
      console.error(`[OCR] 识别失败: ${error.message}`);
      console.error(`[OCR] 错误类型: ${error.constructor.name}`);
      console.error(`[OCR] 错误详情:`, error);
      console.error(`[OCR] 错误堆栈: ${error.stack}`);
      return null;
    }
  }

  /**
   * 下载Discord图片
   */
  private async downloadImage(imageUrl: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new nodeUrl.URL(imageUrl);
      // 动态选择 http 或 https
      const requestLib = url.protocol === "https:" ? nodeHttps : nodeHttp;

      const options: any = {
        method: "GET",
        hostname: url.hostname,
        port: url.port, // 显式传递端口
        path: url.pathname + url.search,
        agent: this.httpAgent,
        timeout: 30000, // 30秒超时
      };

      const req = requestLib.request(options, (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`下载图片失败: HTTP ${res.statusCode}`));
            return;
          }

          const buffer = Buffer.concat(chunks);
          console.log(`[OCR] 图片下载完成，大小: ${buffer.length} bytes`);

          // 性能优化：跳过超大图片（>10MB）
          const maxSize = 10 * 1024 * 1024; // 10MB
          if (buffer.length > maxSize) {
            reject(new Error(`图片过大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)，跳过OCR识别`));
            return;
          }

          resolve(buffer);
        });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error("下载图片超时"));
      });

      req.on("error", (err) => reject(err));
      req.end();
    });
  }

  /**
   * 调用OCR API
   */
  private async callOCRAPI(imageBuffer: Buffer): Promise<OCRResult> {
    const boundary = "----OCRBoundary" + Math.random().toString(16).slice(2);
    const url = new nodeUrl.URL(`${this.serverUrl}/ocr`);

    // !!! 修复点：根据 OCR 服务器的协议选择正确的模块 !!!
    const requestLib = url.protocol === "https:" ? nodeHttps : nodeHttp;

    const parts: (string | Buffer)[] = [];

    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Disposition: form-data; name="image_file"; filename="image.jpg"\r\n`);
    parts.push(`Content-Type: application/octet-stream\r\n\r\n`);
    parts.push(imageBuffer);
    parts.push(`\r\n--${boundary}--\r\n`);

    const payload = Buffer.concat(parts.map(p => typeof p === "string" ? Buffer.from(p) : p));

    const options: any = {
      method: "POST",
      hostname: url.hostname,
      port: url.port, // !!! 修复点：显式传递端口，否则 http 默认80，https 默认443 !!!
      path: url.pathname,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length,
      },
      // 注意：如果是本地 OCR 服务，通常不需要代理，如果配置了 httpAgent 可能会导致连接本地失败
      // 这里保留 agent 但请确保 config 中没有对 localhost 配置代理
      agent: this.httpAgent,
      timeout: 30000, // OCR超时时间30秒，平衡性能和准确性
    };

    return new Promise((resolve, reject) => {
      const req = requestLib.request(options, (res) => {
        let body = "";

        res.on("data", (chunk) => body += chunk);
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`OCR API调用失败: HTTP ${res.statusCode} - ${body}`));
              return;
            }

            const result: OCRResult = JSON.parse(body);
            resolve(result);
          } catch (err: any) {
            reject(new Error(`OCR响应解析失败: ${err.message}`));
          }
        });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error("OCR请求超时 (30秒)"));
      });

      req.on("error", (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  /**
   * 检查OCR结果是否包含指定关键词
   */
  checkOCRKeywords(
    ocrResult: OCRResult | null,
    blockedKeywords: string[]
  ): { shouldBlock: boolean; matchedKeywords: string[] } {
    if (!ocrResult?.data || ocrResult.data.length === 0) {
      return { shouldBlock: false, matchedKeywords: [] };
    }

    // 收集所有识别到的文本
    const allText = ocrResult.data.map(item => item.text).join(" ");
    const lowerText = allText.toLowerCase();

    // 检查是否应该被屏蔽
    if (blockedKeywords.length > 0) {
      const matchedBlocked = blockedKeywords.filter(keyword =>
        lowerText.includes(keyword.toLowerCase())
      );
      if (matchedBlocked.length > 0) {
        return { shouldBlock: true, matchedKeywords: matchedBlocked };
      }
    }

    return { shouldBlock: false, matchedKeywords: [] };
  }
}
