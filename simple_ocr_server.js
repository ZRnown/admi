/**
 * 简单的OCR HTTP服务器
 * 用于测试OCR功能
 *
 * 实现说明：
 * 1. 这是一个简单的HTTP服务器，提供/ocr端点
 * 2. 实际使用时，需要替换为真实的OCR库调用（如PaddleOCR）
 * 3. 当前实现返回示例数据，用于测试API接口
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9003;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// 确保上传目录存在
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * 解析multipart/form-data请求
 */
function parseMultipartRequest(req, callback) {
  const chunks = [];
  let totalLength = 0;

  req.on('data', (chunk) => {
    chunks.push(chunk);
    totalLength += chunk.length;
  });

  req.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);
      const boundary = extractBoundary(req.headers['content-type']);

      if (!boundary) {
        callback(new Error('无法找到boundary'));
        return;
      }

      const parts = buffer.split(Buffer.from(`--${boundary}`));
      const result = {};

      for (const part of parts) {
        if (part.length === 0 || part.toString().startsWith('--')) continue;

        const headersEnd = part.indexOf('\r\n\r\n');
        if (headersEnd === -1) continue;

        const headers = part.slice(0, headersEnd).toString();
        const body = part.slice(headersEnd + 4);

        const nameMatch = headers.match(/name="([^"]+)"/);
        if (!nameMatch) continue;

        const name = nameMatch[1];
        result[name] = body;
      }

      callback(null, result);
    } catch (e) {
      callback(e);
    }
  });
}

/**
 * 从Content-Type提取boundary
 */
function extractBoundary(contentType) {
  if (!contentType) return null;

  const match = contentType.match(/boundary=([^;]+)/);
  if (!match) return null;

  return match[1].trim();
}

/**
 * 保存上传的图片
 */
function saveImage(buffer, filename) {
  const filepath = path.join(UPLOAD_DIR, `${Date.now()}_${filename}`);
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

/**
 * 健康检查端点
 */
function healthCheck(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'OCR Server',
    version: '1.0.0'
  }));
}

/**
 * OCR端点
 */
function ocrEndpoint(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '只支持POST方法' }));
    return;
  }

  parseMultipartRequest(req, (err, formData) => {
    if (err) {
      console.error('解析请求失败:', err);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: '解析请求失败',
        message: err.message
      }));
      return;
    }

    const imageBuffer = formData['image'];
    if (!imageBuffer) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少image字段' }));
      return;
    }

    console.log(`[OCR Server] 收到图片请求，大小: ${imageBuffer.length} bytes`);

    // TODO: 替换为真实的OCR库调用
    // 示例：使用PaddleOCR
    // const result = await recognizeWithPaddleOCR(imageBuffer);

    // 当前返回示例数据
    const mockOCRResult = {
      code: 0,
      msg: 'success',
      data: [
        {
          box: [
            [100, 100],
            [200, 100],
            [200, 200],
            [100, 200]
          ],
          score: 0.95,
          text: '这是示例识别文字'
        },
        {
          box: [
            [100, 250],
            [300, 250],
            [300, 300],
            [100, 300]
          ],
          score: 0.92,
          text: '测试一下'
        }
      ]
    };

    console.log(`[OCR Server] 识别完成，返回 ${mockOCRResult.data.length} 个文本块`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(mockOCRResult));
  });
}

/**
 * 创建HTTP服务器
 */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  console.log(`[OCR Server] ${req.method} ${req.url}`);

  // 设置CORS头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 处理OPTIONS预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 路由处理
  if (url.pathname === '/health') {
    healthCheck(req, res);
  } else if (url.pathname === '/ocr') {
    ocrEndpoint(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未找到端点' }));
  }
});

// 启动服务器
server.listen(PORT, () => {
  console.log('========================================');
  console.log('OCR HTTP Server');
  console.log('========================================');
  console.log(`服务器运行在: http://localhost:${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/health`);
  console.log(`OCR端点: http://localhost:${PORT}/ocr`);
  console.log('');
  console.log('注意: 当前实现返回示例数据');
  console.log('      实际使用时请替换为真实的OCR库调用');
  console.log('========================================');
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[OCR Server] 收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('[OCR Server] 服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[OCR Server] 收到SIGINT信号，正在关闭服务器...');
  server.close(() => {
    console.log('[OCR Server] 服务器已关闭');
    process.exit(0);
  });
});
