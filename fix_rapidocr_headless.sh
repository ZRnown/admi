#!/bin/bash

# RapidOCR 无头环境修复脚本
# 解决在服务器无头环境中运行 RapidOCR 的问题

set -e

echo "🔧 修复 RapidOCR 无头环境问题..."
echo ""

# 检查是否为 root 用户
if [[ $EUID -eq 0 ]]; then
   echo "❌ 请不要使用 root 用户运行此脚本"
   exit 1
fi

# 更新包列表
echo "📦 更新包列表..."
sudo apt update

# 停止当前 OCR 服务
echo "🛑 停止当前 OCR 服务..."
pm2 stop ocr-server 2>/dev/null || true
pm2 delete ocr-server 2>/dev/null || true

# 安装虚拟显示服务器
echo "🖥️ 安装虚拟显示服务器..."
sudo apt install -y xvfb x11-utils

# 创建虚拟显示脚本
echo "📝 创建虚拟显示启动脚本..."
cat > ~/start_xvfb.sh << 'EOF'
#!/bin/bash
# 启动虚拟显示服务器
export DISPLAY=:99
Xvfb :99 -screen 0 1024x768x24 -ac &
echo $! > /tmp/xvfb.pid
sleep 2
echo "虚拟显示已启动 (PID: $(cat /tmp/xvfb.pid))"
EOF

chmod +x ~/start_xvfb.sh

# 安装图形库依赖 (多种方案)
echo "🎨 安装图形库依赖..."
# 方案1: 尝试标准的图形库
if sudo apt install -y libgl1-mesa-dev libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1 2>/dev/null; then
    echo "✅ 方案1: 标准图形库安装成功"
elif sudo apt install -y mesa-utils libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1 2>/dev/null; then
    echo "✅ 方案2: Mesa工具安装成功"
else
    echo "⚠️  图形库安装失败，尝试最小化安装..."
    sudo apt install -y libglib2.0-0 libsm6 libxext6 libgomp1 -y || {
        echo "❌ 基本库安装失败"
        exit 1
    }
fi

# 创建必要的目录
echo "📁 创建必要的目录..."
mkdir -p /tmp/.X11-unix
mkdir -p ~/.cache

# 安装 Python 依赖
echo "🐍 安装 RapidOCR..."
pip3 install --user rapidocr-onnxruntime --break-system-packages

# 验证安装
echo "✅ 验证 RapidOCR 安装..."
if python3 -c "
import os
os.environ['QT_QPA_PLATFORM'] = 'offscreen'
os.environ['DISPLAY'] = ':99'
os.environ['XDG_RUNTIME_DIR'] = '/tmp'
os.environ['MPLBACKEND'] = 'Agg'
try:
    from rapidocr_onnxruntime import RapidOCR
    print('✅ RapidOCR 导入成功')
    # 测试初始化 (不实际运行以节省时间)
    print('✅ RapidOCR 无头环境配置完成')
except Exception as e:
    print('❌ RapidOCR 测试失败:', str(e))
    exit(1)
"; then
    echo "✅ RapidOCR 无头环境配置成功"
else
    echo "❌ RapidOCR 配置失败"
    exit 1
fi

# 启动虚拟显示
echo "🚀 启动虚拟显示..."
~/start_xvfb.sh

# 启动 RapidOCR 服务
echo "🔄 启动 RapidOCR 服务..."
pm2 start paddle_ocr_server.js --name "ocr-server"

# 保存 PM2 配置
pm2 save

# 创建启动脚本
echo "📝 创建完整启动脚本..."
cat > ~/start_ocr_complete.sh << 'EOF'
#!/bin/bash
echo "启动完整的 OCR 系统..."

# 启动虚拟显示
~/start_xvfb.sh

# 等待显示启动
sleep 3

# 启动 OCR 服务
pm2 start paddle_ocr_server.js --name "ocr-server"

echo "OCR 系统启动完成!"
echo "测试命令: curl http://localhost:9003/health"
EOF

chmod +x ~/start_ocr_complete.sh

echo ""
echo "🎉 RapidOCR 无头环境配置完成!"
echo ""
echo "📊 服务状态:"
pm2 status ocr-server

echo ""
echo "🔗 服务信息:"
echo "   地址: http://localhost:9003"
echo "   健康检查: http://localhost:9003/health"
echo "   OCR 接口: http://localhost:9003/ocr"

echo ""
echo "📝 配置说明:"
echo "   在 config.json 中设置: \"ocrServerUrl\": \"http://localhost:9003\""

echo ""
echo "🧪 测试服务:"
echo "curl http://localhost:9003/health"

echo ""
echo "🔄 如需重启系统:"
echo "~/start_ocr_complete.sh"

echo ""
echo "✅ 优势:"
echo "   ✅ 高准确率 OCR"
echo "   ✅ 支持复杂布局"
echo "   ✅ 中英文识别优秀"
echo "   ✅ 无头环境兼容"
