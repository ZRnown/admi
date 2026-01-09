/**
 * OCR功能测试脚本
 * 用于验证OCR服务是否正常工作
 */

const http = require('http');
const https = require('https');
const fs = require('fs');

const OCR_SERVER_URL = 'http://localhost:9003';
const TEST_IMAGES = [
  // 测试图片URL（Discord或其他可访问的图片URL）
  'https://via.placeholder.com/300x150.png?text=Hello+World',
  'https://via.placeholder.com/300x150.png?text=测试一下',
];

async function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败: HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function callOCR(imageBuffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----OCRTest' + Math.random().toString(16).slice(2);
    const url = new URL(`${OCR_SERVER_URL}/ocr`);

    const parts = [];
    parts.push(`--${boundary}\r\n`);
    parts.push(`Content-Disposition: form-data; name="image"; filename="test.jpg"\r\n`);
    parts.push(`Content-Type: application/octet-stream\r\n\r\n`);
    parts.push(imageBuffer);
    parts.push(`\r\n--${boundary}--\r\n`);

    const payload = Buffer.concat(parts.map(p => typeof p === 'string' ? Buffer.from(p) : p));

    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': payload.length,
      },
      timeout: 30000,
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OCR API调用失败: HTTP ${res.statusCode} - ${body}`));
          return;
        }

        try {
          const result = JSON.parse(body);
          resolve(result);
        } catch (e) {
          reject(new Error(`解析响应失败: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    req.write(payload);
    req.end();
  });
}

function checkOCRKeywords(ocrResult, blockedKeywords) {
  if (!ocrResult?.data || ocrResult.data.length === 0) {
    return { shouldBlock: false, matchedKeywords: [] };
  }

  const allText = ocrResult.data.map(item => item.text).join(' ');
  const lowerText = allText.toLowerCase();

  const matchedBlocked = blockedKeywords.filter(keyword =>
    lowerText.includes(keyword.toLowerCase())
  );

  if (matchedBlocked.length > 0) {
    return { shouldBlock: true, matchedKeywords: matchedBlocked };
  }

  return { shouldBlock: false, matchedKeywords: [] };
}

async function testOCR() {
  console.log('========================================');
  console.log('OCR功能测试');
  console.log('========================================');
  console.log(`OCR服务器: ${OCR_SERVER_URL}`);
  console.log('');

  // 1. 测试OCR服务器连接
  console.log('步骤1: 测试OCR服务器连接...');
  try {
    await new Promise((resolve, reject) => {
      http.get(`${OCR_SERVER_URL}/health`, (res) => {
        if (res.statusCode === 200) {
          console.log('✅ OCR服务器连接成功');
          resolve();
        } else {
          reject(new Error(`健康检查失败: HTTP ${res.statusCode}`));
        }
      }).on('error', (err) => {
        console.warn('⚠️  健康检查端点不存在，但这不影响功能');
        resolve(); // 不健康检查端点也继续
      });
    });
  } catch (e) {
    console.error('❌ OCR服务器连接失败:', e.message);
    return;
  }
  console.log('');

  // 2. 测试图片识别
  const blockedKeywords = ['测试一下', '广告', '垃圾'];

  for (let i = 0; i < TEST_IMAGES.length; i++) {
    const imageUrl = TEST_IMAGES[i];
    console.log(`----------------------------------------`);
    console.log(`测试图片 ${i + 1}/${TEST_IMAGES.length}: ${imageUrl}`);
    console.log('');

    try {
      // 下载图片
      console.log('步骤1: 下载图片...');
      const imageBuffer = await downloadImage(imageUrl);
      console.log(`✅ 图片下载成功，大小: ${imageBuffer.length} bytes`);

      // 调用OCR
      console.log('步骤2: 调用OCR API...');
      const ocrResult = await callOCR(imageBuffer);
      console.log(`✅ OCR识别成功，检测到 ${ocrResult.data?.length || 0} 个文本块`);

      // 显示识别结果
      if (ocrResult.data && ocrResult.data.length > 0) {
        const allText = ocrResult.data.map(item => item.text).join(' ');
        console.log(`识别到的文字: "${allText}"`);
      }

      // 测试关键词检测
      console.log('步骤3: 测试关键词检测...');
      const { shouldBlock, matchedKeywords } = checkOCRKeywords(ocrResult, blockedKeywords);

      if (shouldBlock) {
        console.log(`⛔ 检测到屏蔽词: "${matchedKeywords.join('", "')}"`);
        console.log(`🚫 结果: 应该阻止转发`);
      } else {
        console.log(`✅ 未检测到屏蔽词`);
        console.log(`✅ 结果: 允许转发`);
      }

    } catch (e) {
      console.error(`❌ 测试失败: ${e.message}`);
    }

    console.log('');
  }

  console.log('========================================');
  console.log('测试完成');
  console.log('========================================');
}

// 运行测试
testOCR().catch(console.error);
