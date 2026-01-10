#!/bin/bash

# OCR 服务器快速修复脚本
# 解决 libGL.so.1 错误和 OCR 服务部署问题

set -e

echo "🔧 开始修复 OCR 服务器..."



# 更新包列表
echo "📦 更新包列表..."
sudo apt update

# 方案1: 安装轻量级 OCR (推荐)
echo "🚀 安装轻量级 OCR 依赖..."
sudo apt install -y tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng
pip3 install --user pillow pytesseract numpy --break-system-packages

# 验证安装
echo "✅ 验证 Tesseract 安装..."
python3 -c "import pytesseract; print('Tesseract版本:', pytesseract.get_tesseract_version())"

# 方案2: 安装图形库 (可选，如果想使用 RapidOCR)
echo "🎨 安装图形库依赖 (用于 RapidOCR)..."
sudo apt install -y libgl1-mesa-glx libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1

# 安装 RapidOCR (可选)
echo "📚 安装 RapidOCR (可选)..."
pip3 install --user rapidocr-onnxruntime

# 验证 RapidOCR 安装
echo "✅ 验证 RapidOCR 安装..."
if python3 -c "from rapidocr_onnxruntime import RapidOCR; print('RapidOCR 安装成功')"; then
    echo "✅ RapidOCR 可用"
else
    echo "⚠️  RapidOCR 安装失败，但轻量级 OCR 可以使用"
fi

echo ""
echo "🎯 启动 OCR 服务..."
echo "选择 OCR 服务类型："
echo "1) 轻量级 OCR (推荐，端口 9004)"
echo "2) RapidOCR (需要图形库，端口 9003)"
read -p "请选择 (1/2): " choice

case $choice in
    1)
        echo "🚀 启动轻量级 OCR 服务..."
        pm2 start simple_ocr_server.js --name "ocr-server" || {
            echo "❌ PM2 启动失败，请手动运行: node simple_ocr_server.js"
        }
        SERVER_PORT=9004
        ;;
    2)
        echo "🚀 启动 RapidOCR 服务..."
        pm2 start paddle_ocr_server.js --name "ocr-server" || {
            echo "❌ PM2 启动失败，请手动运行: node paddle_ocr_server.js"
        }
        SERVER_PORT=9003
        ;;
    *)
        echo "❌ 无效选择，使用轻量级 OCR"
        pm2 start simple_ocr_server.js --name "ocr-server"
        SERVER_PORT=9004
        ;;
esac

# 保存 PM2 配置
pm2 save

echo ""
echo "🎉 OCR 服务修复完成!"
echo "📊 服务状态:"
pm2 status

echo ""
echo "🔗 服务地址: http://localhost:$SERVER_PORT"
echo "💚 健康检查: http://localhost:$SERVER_PORT/health"
echo "🔍 OCR 接口: http://localhost:$SERVER_PORT/ocr"

echo ""
echo "📝 请在 config.json 中配置:"
echo "\"ocrServerUrl\": \"http://localhost:$SERVER_PORT\","

echo ""
echo "🧪 测试 OCR 服务:"
echo "curl http://localhost:$SERVER_PORT/health"
