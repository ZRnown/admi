/**
 * 轻量级 OCR 服务器
 * 完全避免 OpenCV 依赖，使用纯 Python 图像处理
 *
 * 依赖安装：
 * pip install pillow pytesseract numpy
 * sudo apt install tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9004; // 避免与现有服务冲突

/**
 * 使用 Tesseract OCR (不需要 OpenCV)
 */
function recognizeWithTesseract(imageBuffer, callback) {
  const imageTempPath = path.join(__dirname, `temp_${Date.now()}.png`);
  fs.writeFileSync(imageTempPath, imageBuffer);

  const pythonScript = `
import sys
import json
import traceback
import os
from PIL import Image
import pytesseract
import numpy as np

try:
    image_path = '${imageTempPath}'

    # 使用 PIL 读取图片 (不需要 OpenCV)
    image = Image.open(image_path)

    # 转换为 RGB 模式 (如果需要)
    if image.mode not in ('L', 'RGB'):
        image = image.convert('RGB')

    # 执行 OCR 识别
    # 支持中文和英文
    text = pytesseract.image_to_string(image, lang='chi_sim+eng')

    # 简单模拟检测结果 (实际应用中可能需要更复杂的文本定位)
    # 这里我们返回一个简单的边界框和识别结果
    result = [{
        "box": [[10, 10], [image.width - 10, 10], [image.width - 10, image.height - 10], [10, image.height - 10]],
        "score": 0.95,
        "text": text.strip()
    }] if text.strip() else []

    print(json.dumps({"code": 0, "msg": "success", "data": result}, ensure_ascii=False))

except Exception as e:
    error_msg = str(e) + "\\n" + traceback.format_exc()
    print(json.dumps({"code": 1, "msg": error_msg, "data": []}, ensure_ascii=False))
`;

  const pythonProcess = spawn('python3', ['-c', pythonScript], {
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  pythonProcess.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  pythonProcess.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  pythonProcess.on('close', (code) => {
    // 清理临时文件
    try {
      fs.unlinkSync(imageTempPath);
    } catch (e) {
      console.error('清理临时文件失败:', e.message);
    }

    if (code === 0) {
      try {
        const result = JSON.parse(stdout.trim());
        callback(null, result);
      } catch (e) {
        callback(new Error('解析OCR结果失败: ' + e.message), null);
      }
    } else {
      callback(new Error(`OCR进程退出码 ${code}, 错误: ${stderr}`), null);
    }
  });

  pythonProcess.on('error', (err) => {
    callback(err, null);
  });
}

/**
 * 解析 multipart/form-data 请求
 */
function parseMultipartRequest(req, callback) {
  const boundary = req.headers['content-type']?.split('boundary=')[1];
  if (!boundary) {
    callback(new Error('无效的 Content-Type'));
    return;
  }

  let body = Buffer.alloc(0);

  req.on('data', (chunk) => {
    body = Buffer.concat([body, chunk]);
  });

  req.on('end', () => {
    try {
      const parts = body.toString().split('--' + boundary).slice(1, -1);
      let imageBuffer = null;

      for (const part of parts) {
        const lines = part.split('\r\n');
        const contentDisposition = lines.find(line => line.includes('Content-Disposition'));

        if (contentDisposition && (contentDisposition.includes('name="image"') || contentDisposition.includes('name="image_file"'))) {
          // 找到图片数据
          const dataStart = part.indexOf('\r\n\r\n') + 4;
          imageBuffer = body.slice(body.indexOf(part) + dataStart, body.indexOf(part) + part.length - 2);
          break;
        }
      }

      if (!imageBuffer) {
        callback(new Error('未找到图片数据'));
        return;
      }

      callback(null, imageBuffer);
    } catch (e) {
      callback(e);
    }
  });
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/ocr') {
    console.log('[Simple OCR Server] 收到OCR请求');

    parseMultipartRequest(req, (err, imageBuffer) => {
      if (err) {
        console.error('[Simple OCR Server] 解析请求失败:', err.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 1, msg: err.message, data: [] }));
        return;
      }

      console.log(`[Simple OCR Server] 图片大小: ${imageBuffer.length} bytes`);

      recognizeWithTesseract(imageBuffer, (ocrErr, result) => {
        if (ocrErr) {
          console.error('[Simple OCR Server] OCR识别失败:', ocrErr.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 1, msg: ocrErr.message, data: [] }));
          return;
        }

        console.log(`[Simple OCR Server] 识别完成，找到 ${result.data.length} 个文本块`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    // 健康检查
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'simple-ocr-server' }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 1, msg: '接口不存在', data: [] }));
  }
});

// 启动服务器
server.listen(PORT, () => {
  console.log(`[Simple OCR Server] 服务启动成功，监听端口 ${PORT}`);
  console.log(`[Simple OCR Server] 健康检查: http://localhost:${PORT}/health`);
  console.log(`[Simple OCR Server] OCR接口: http://localhost:${PORT}/ocr`);
});

// 错误处理
server.on('error', (err) => {
  console.error('[Simple OCR Server] 服务器错误:', err.message);
});

process.on('SIGINT', () => {
  console.log('[Simple OCR Server] 正在关闭服务器...');
  server.close(() => {
    console.log('[Simple OCR Server] 服务器已关闭');
    process.exit(0);
  });
});