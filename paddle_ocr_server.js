/**
 * PaddleOCR 集成服务器
 * 基于Node.js的轻量级OCR服务器，使用PaddleOCR进行文字识别
 *
 * 安装依赖：
 * npm install paddleocr onnxruntime-node
 *
 * 或者使用Python后端：
 * pip install paddlepaddle paddleocr
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9003;

/**
 * 方式1：使用PaddleOCR Node.js绑定
 * 需要：npm install paddleocr onnxruntime-node
 */
async function recognizeWithPaddleOCRJS(imageBuffer) {
  try {
    const PaddleOCR = require('paddleocr');
    const ocr = new PaddleOCR();

    const result = await ocr.ocr(imageBuffer);

    console.log(`[PaddleOCR] 识别到 ${result.length} 个文本块`);

    return {
      code: 0,
      msg: 'success',
      data: result.map(item => ({
        box: item.box,
        score: item.confidence || 1.0,
        text: item.text
      }))
    };
  } catch (error) {
    console.error('[PaddleOCR] JS绑定识别失败:', error);
    throw error;
  }
}

/**
 * 方式2：调用Python PaddleOCR后端
 * 需要：pip install paddlepaddle paddleocr
 */
function recognizeWithPythonOCR(imageBuffer, callback) {
  const imageTempPath = path.join(__dirname, 'temp_ocr.png');
  fs.writeFileSync(imageTempPath, imageBuffer);

  const pythonScript = `
import paddleocr
import sys
import json

# 读取图片
image_path = '${imageTempPath}'

# 初始化OCR引擎（轻量级模型，适合低配置服务器）
ocr = paddleocr.PaddleOCR(
    use_angle_cls=True, 
    lang='ch',  # 中英文混合识别
    use_gpu=False,  # 使用CPU，适合4G4H服务器
    det_model_dir='./',
    rec_model_dir='./',
    cls_model_dir='./',
    show_log=False
)

# 识别文字
result = ocr.ocr(image_path, cls=True)

# 转换为标准格式
output = []
for line in result:
    if line:
        points = line[0]
        text_info = line[1]
        output.append({
            "box": [[p[0], p[1]] for p in points],
            "score": text_info[1],
            "text": text_info[0]
        })

# 输出JSON
print(json.dumps({"code": 0, "msg": "success", "data": output}))
`;

  const pythonProcess = spawn('python3', ['-c', pythonScript], {
    cwd: __dirname
  });

  let output = '';
  let error = '';

  pythonProcess.stdout.on('data', (data) => {
    output += data.toString();
  });

  pythonProcess.stderr.on('data', (data) => {
    error += data.toString();
  });

  pythonProcess.on('close', (code) => {
    // 清理临时文件
    try {
      fs.unlinkSync(imageTempPath);
    } catch (e) {
      console.warn('[OCR] 清理临时文件失败:', e);
    }

    if (code !== 0) {
      console.error('[Python OCR] 执行失败:', error);
      callback(new Error('Python OCR执行失败'));
      return;
    }

    try {
      const result = JSON.parse(output);
      callback(null, result);
    } catch (e) {
      console.error('[Python OCR] 解析响应失败:', e);
      callback(new Error('解析OCR响应失败'));
    }
  });
}

/**
 * 方式3：调用外部OCR API
 * 适用于部署在单独的服务器上的OCR服务
 */
async function recognizeWithExternalAPI(imageBuffer, apiUrl = 'http://your-ocr-server/ocr') {
  return new Promise((resolve, reject) => {
    const boundary = '----OCR' + Math.random().toString(16).slice(2);
    const url = new URL(apiUrl);

    const parts = [];
    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Disposition: form-data; name="image"; filename="image.jpg"\r\n`);
    parts.push(`Content-Type: application/octet-stream\r\n\r\n`);
    parts.push(imageBuffer);
    parts.push(`\r\n--${boundary}--\r\n`);

    const payload = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

    const options = {
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length
      },
      timeout: 60000
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(body);
            resolve(result);
          } catch (e) {
            reject(new Error('解析响应失败'));
          }
        } else {
          reject(new Error(`OCR API调用失败: HTTP ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.write(payload);
    req.end();
  });
}

/**
 * HTTP服务器实现
 */
function parseMultipartRequest(req, callback) {
  const chunks = [];

  req.on('data', (chunk) => {
    chunks.push(chunk);
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

function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=([^;]+)/);
  if (!match) return null;
  return match[1].trim();
}

async function handleOCRRequest(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '只支持POST方法' }));
    return;
  }

  console.log('[OCR Server] 收到OCR请求');

  parseMultipartRequest(req, (err, formData) => {
    if (err) {
      console.error('[OCR Server] 解析请求失败:', err);
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

    console.log(`[OCR Server] 图片大小: ${imageBuffer.length} bytes`);

    // 选择OCR方式（根据你的环境选择）

    // 方式1: PaddleOCR Node.js绑定（推荐，性能最好）
    // recognizeWithPaddleOCRJS(imageBuffer)
    //   .then(result => sendResponse(res, result))
    //   .catch(error => sendError(res, error));

    // 方式2: Python PaddleOCR（推荐，准确率最高）
    recognizeWithPythonOCR(imageBuffer, (error, result) => {
      if (error) {
        sendError(res, error);
      } else {
        sendResponse(res, result);
      }
    });

    // 方式3: 外部API（适用于分布式部署）
    // recognizeWithExternalAPI(imageBuffer)
    //   .then(result => sendResponse(res, result))
    //   .catch(error => sendError(res, error));
  });
}

function sendResponse(res, result) {
  console.log(`[OCR Server] 识别完成，返回 ${result.data?.length || 0} 个文本块`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

function sendError(res, error) {
  console.error('[OCR Server] OCR失败:', error.message);

  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: 'OCR识别失败',
    message: error.message
  }));
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    service: 'PaddleOCR Server',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  console.log(`[OCR Server] ${req.method} ${req.url}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    handleHealth(req, res);
  } else if (url.pathname === '/ocr') {
    handleOCRRequest(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: '未找到端点' }));
  }
});

server.listen(PORT, () => {
  console.log('========================================');
  console.log('PaddleOCR Server');
  console.log('========================================');
  console.log(`服务器地址: http://localhost:${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/health`);
  console.log(`OCR端点: http://localhost:${PORT}/ocr`);
  console.log('');
  console.log('支持三种OCR方式：');
  console.log('1. PaddleOCR Node.js绑定（性能最好）');
  console.log('2. Python PaddleOCR（准确率最高）');
  console.log('3. 外部API调用（分布式部署）');
  console.log('');
  console.log('请根据注释选择合适的方式');
  console.log('========================================');
});

process.on('SIGTERM', () => {
  console.log('[OCR Server] 正在关闭...');
  server.close(() => {
    console.log('[OCR Server] 已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[OCR Server] 正在关闭...');
  server.close(() => {
    console.log('[OCR Server] 已关闭');
    process.exit(0);
  });
});
