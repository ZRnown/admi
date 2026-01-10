/**
 * RapidOCR (ONNX Runtime) 集成服务器
 * 专为 4H4G 服务器优化：高准确率、低内存占用、CPU推理快
 *
 * 必需依赖：
 * pip install rapidocr_onnxruntime
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 9003;

/**
 * 调用 Python RapidOCR
 * 使用 ONNX Runtime，无需安装完整的 PaddlePaddle，适合轻量级服务器
 */
function recognizeWithPythonOCR(imageBuffer, callback) {
  const imageTempPath = path.join(__dirname, `temp_${Date.now()}.png`);
  fs.writeFileSync(imageTempPath, imageBuffer);

  const pythonScript = `

import sys
import json
import traceback
import os

# 设置环境变量以支持 headless 模式
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['DISPLAY'] = ''

try:
    from rapidocr_onnxruntime import RapidOCR

    # 初始化 OCR 引擎 (CPU 模式)
    # det_use_gpu=False, cls_use_gpu=False, rec_use_gpu=False 确保在 CPU 模式下运行
    # RapidOCR 会自动下载并加载 PP-OCRv4 模型 (高准确率)
    engine = RapidOCR()

    image_path = '${imageTempPath}'

    # 执行识别
    result, elapse = engine(image_path)

    output = []
    if result:
        for item in result:
            # item 结构: [det_box, text, score]
            # det_box 是 [[x1, y1], [x2, y2], [x3, y3], [x4, y4]]
            box = item[0]
            text = item[1]
            score = item[2]

            output.append({
                "box": box,
                "score": score,
                "text": text
            })

    print(json.dumps({"code": 0, "msg": "success", "data": output}, ensure_ascii=False))

except Exception as e:
    # 捕获所有异常并以 JSON 格式输出，方便 Node.js 捕获
    error_msg = str(e) + "\\n" + traceback.format_exc()
    print(json.dumps({"code": 1, "msg": error_msg, "data": []}, ensure_ascii=False))

`;

  const pythonProcess = spawn('python3', ['-c', pythonScript], {
    cwd: __dirname
  });

  let outputData = '';
  let errorData = '';

  pythonProcess.stdout.on('data', (data) => {
    outputData += data.toString();
  });

  pythonProcess.stderr.on('data', (data) => {
    errorData += data.toString();
  });

  pythonProcess.on('close', (code) => {
    // 清理临时文件
    try {
      if (fs.existsSync(imageTempPath)) {
        fs.unlinkSync(imageTempPath);
      }
    } catch (e) {
      console.warn('[OCR Server] 清理临时文件失败:', e);
    }

    if (code !== 0) {
      console.error('[RapidOCR] Python 进程异常退出:', errorData || outputData);
      callback(new Error('OCR 进程异常退出'));
      return;
    }

    try {
      // Python print 的内容可能包含换行符，取最后一行有效的 JSON
      const lines = outputData.trim().split('\n');
      const lastLine = lines[lines.length - 1];
      const result = JSON.parse(lastLine);

      if (result.code !== 0) {
        console.error('[RapidOCR] 内部错误:', result.msg);
        callback(new Error('RapidOCR 识别出错: ' + result.msg));
      } else {
        callback(null, result);
      }
    } catch (e) {
      console.error('[RapidOCR] 解析响应失败. 原始内容:', outputData);
      console.error('[RapidOCR] 标准错误输出:', errorData);
      callback(new Error('解析 OCR 响应失败'));
    }
  });
}

/**
 * HTTP服务器请求处理
 */
function parseMultipartRequest(req, callback) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const buffer = Buffer.concat(chunks);
      const contentType = req.headers['content-type'];
      if (!contentType) return callback(new Error('缺少 Content-Type'));

      const boundaryMatch = contentType.match(/boundary=([^;]+)/);
      if (!boundaryMatch) return callback(new Error('无法找到 boundary'));

      const boundary = boundaryMatch[1].trim();
      const boundaryBuffer = Buffer.from(`--${boundary}`);
      const endBoundaryBuffer = Buffer.from(`--${boundary}--`);

      const result = {};

      let start = 0;
      while (start < buffer.length) {
        // 查找下一个boundary
        const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
        if (boundaryIndex === -1) break;

        // 检查是否是结束boundary
        const endBoundaryIndex = buffer.indexOf(endBoundaryBuffer, start);
        if (endBoundaryIndex !== -1 && endBoundaryIndex < boundaryIndex) {
          break;
        }

        // 移动到boundary之后
        start = boundaryIndex + boundaryBuffer.length;

        // 跳过 \r\n
        if (start + 1 < buffer.length && buffer[start] === 13 && buffer[start + 1] === 10) {
          start += 2;
        } else if (start < buffer.length && buffer[start] === 10) {
          start += 1;
        }

        // 查找头部结束位置
        const headerEndIndex = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
        if (headerEndIndex === -1) continue;

        // 解析头部
        const headers = buffer.slice(start, headerEndIndex).toString();
        const nameMatch = headers.match(/name="([^"]+)"/);
        if (!nameMatch) continue;

        // 获取数据部分
        const dataStart = headerEndIndex + 4;
        const nextBoundaryIndex = buffer.indexOf(boundaryBuffer, dataStart);
        const dataEnd = nextBoundaryIndex !== -1 ? nextBoundaryIndex - 2 : buffer.length; // 减去 \r\n

        if (dataEnd > dataStart) {
          result[nameMatch[1]] = buffer.slice(dataStart, dataEnd);
        }

        start = dataEnd;
      }

      callback(null, result);
    } catch (e) {
      callback(e);
    }
  });
}

function handleOCRRequest(req, res) {
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
      res.end(JSON.stringify({ error: '解析请求失败', message: err.message }));
      return;
    }

    // 兼容不同的字段名 (image 或 image_file)
    const imageBuffer = formData['image'] || formData['image_file'];

    if (!imageBuffer) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '缺少图片数据 (image 或 image_file)' }));
      return;
    }

    console.log(`[OCR Server] 图片大小: ${imageBuffer.length} bytes`);

    recognizeWithPythonOCR(imageBuffer, (error, result) => {
      if (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'OCR识别失败', message: error.message }));
      } else {
        console.log(`[OCR Server] 识别完成，返回 ${result.data?.length || 0} 个文本块`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    });
  });
}

function handleHealth(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'RapidOCR Server' }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

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

server.listen(PORT, '127.0.0.1', () => {
  console.log('========================================');
  console.log('RapidOCR Server (ONNX Runtime)');
  console.log('========================================');
  console.log(`监听地址: http://127.0.0.1:${PORT}`);
  console.log('适用环境: 4H4G 服务器，高准确率，低内存');
  console.log('========================================');
});