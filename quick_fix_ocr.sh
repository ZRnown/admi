#!/bin/bash

# 快速修复 OCR 服务器 - 推荐方案
# 直接使用轻量级 OCR，避免图形库依赖问题

set -e

echo "🔧 快速修复 OCR 服务器..."
echo "🎯 使用轻量级 OCR (推荐，无需图形库)"
echo ""

# 更新包列表
echo "📦 更新包列表..."
sudo apt update

# 安装轻量级 OCR 依赖
echo "🚀 安装轻量级 OCR 依赖..."
sudo apt install -y tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng

# 安装 Python 依赖
echo "🐍 安装 Python 依赖..."
pip3 install --user pillow pytesseract numpy --break-system-packages

# 验证安装
echo "✅ 验证安装..."
if python3 -c "import pytesseract; print('Tesseract版本:', pytesseract.get_tesseract_version())"; then
    echo "✅ Tesseract OCR 安装成功"
else
    echo "❌ Tesseract 安装失败"
    exit 1
fi

# 停止可能存在的 OCR 服务
echo "🛑 停止旧的 OCR 服务..."
pm2 stop ocr-server 2>/dev/null || true
pm2 delete ocr-server 2>/dev/null || true

# 启动轻量级 OCR 服务
echo "🚀 启动轻量级 OCR 服务..."
pm2 start simple_ocr_server.js --name "ocr-server"

# 保存 PM2 配置
pm2 save

echo ""
echo "🎉 OCR 服务修复完成!"
echo "📊 服务状态:"
pm2 status ocr-server

echo ""
echo "🔗 服务信息:"
echo "   地址: http://localhost:9004"
echo "   健康检查: http://localhost:9004/health"
echo "   OCR 接口: http://localhost:9004/ocr"

echo ""
echo "📝 请在 config.json 中配置:"
echo "\"ocrServerUrl\": \"http://localhost:9004\","

echo ""
echo "🧪 测试服务:"
echo "curl http://localhost:9004/health"

echo ""
echo "✅ 轻量级 OCR 优势:"
echo "   ✅ 无需图形库"
echo "   ✅ 内存占用小"
echo "   ✅ 完全兼容服务器环境"
echo "   ✅ 安装简单快速"
