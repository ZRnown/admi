#!/bin/bash

# Discord Bot 快速部署脚本（适用于宝塔面板）
# 使用方法：chmod +x deploy.sh && ./deploy.sh

set -e

echo "🚀 开始部署 Discord Bot..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 错误: 未找到 Node.js，请先在宝塔面板安装 Node.js"
    exit 1
fi

# 检查 pnpm
if ! command -v pnpm &> /dev/null; then
    echo "📦 安装 pnpm..."
    npm install -g pnpm
fi

# 安装依赖
echo "📦 安装项目依赖..."
pnpm install

# 编译项目
echo "🔨 编译 Bot 代码..."
pnpm build:bot

echo "🔨 编译服务器代码..."
pnpm build:server

# 创建日志目录
mkdir -p logs

# 检查 PM2
if ! command -v pm2 &> /dev/null; then
    echo "📦 安装 PM2..."
    npm install -g pm2
fi

# 停止旧进程（如果存在）
echo "🛑 停止旧进程..."
pm2 stop discord-bot discord-web 2>/dev/null || true
pm2 delete discord-bot discord-web 2>/dev/null || true

# 启动服务
echo "▶️  启动服务..."
pm2 start ecosystem.config.js

# 保存 PM2 配置
pm2 save

echo ""
echo "✅ 部署完成！"
echo ""
echo "📊 查看状态: pm2 status"
echo "📋 查看日志: pm2 logs discord-bot"
echo "🌐 管理界面: http://$(hostname -I | awk '{print $1}'):3000"
echo ""
echo "💡 提示: 如果管理界面无法访问，请检查防火墙是否开放 3000 端口"

