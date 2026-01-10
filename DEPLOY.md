# 🚀 服务器部署指南

## 📋 服务器要求

### 最低配置
- **操作系统**: Linux (Ubuntu 20.04+ / CentOS 7+)
- **内存**: 512MB RAM
- **存储**: 1GB 可用空间
- **网络**: 稳定的互联网连接

### 推荐配置
- **操作系统**: Ubuntu 22.04 LTS
- **内存**: 1GB RAM (如果需要 OCR 功能，建议 2GB)
- **存储**: 5GB SSD
- **CPU**: 1核 (如果需要 OCR 功能，建议 2核)

## 🔧 环境准备

### 1. 更新系统
```bash
sudo apt update && sudo apt upgrade -y
```

### 2. 安装 Node.js (推荐版本: 18+)
```bash
# 使用 NodeSource 仓库
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证安装
node --version
npm --version
```

### 3. 安装 pnpm (推荐包管理器)
```bash
npm install -g pnpm
```

### 4. 安装 Python3 (用于 OCR 功能)
```bash
sudo apt install python3 python3-pip -y
```

### 5. 安装 PM2 (进程管理器)
```bash
npm install -g pm2
```

## 📦 项目部署

### 1. 下载项目
```bash
cd ~
git clone https://github.com/your-repo/discord-forwarder.git
cd discord-forwarder
```

### 2. 安装依赖
```bash
pnpm install --production
```

### 3. 构建项目
```bash
# 构建 Bot
pnpm build:bot

# 如果需要管理界面
pnpm build:server
```

## ⚙️ 配置

### 1. 创建配置文件
```bash
cp config.sample.json config.json
```

### 2. 编辑配置文件
```bash
nano config.json
```

基本配置示例：
```json
{
  "accounts": [
    {
      "id": "main",
      "name": "主账号",
      "type": "selfbot",
      "token": "你的Discord Token",
      "proxyUrl": "",
      "mappings": [
        {
          "id": "rule1",
          "sourceChannelId": "源频道ID",
          "targetWebhookUrl": "目标Webhook URL"
        }
      ]
    }
  ]
}
```

### 3. 环境变量 (可选)
```bash
# 创建 .env 文件
nano .env
```

内容示例：
```env
# 飞书配置 (如果使用飞书转发)
FEISHU_APP_ID=your_app_id
FEISHU_APP_SECRET=your_app_secret

# 翻译服务配置 (如果使用翻译功能)
DEEPSEEK_API_KEY=your_deepseek_key

# 其他配置
NODE_ENV=production
```

## 🔍 OCR 功能配置 (可选)

### 方案1: 轻量级 OCR (推荐)
```bash
# 安装依赖
sudo apt install tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng -y
pip3 install pillow pytesseract numpy

# 验证安装
python3 -c "import pytesseract; print('Tesseract版本:', pytesseract.get_tesseract_version())"

# 启动轻量级 OCR 服务器
pm2 start simple_ocr_server.js --name "ocr-server"
```

### 方案2: RapidOCR (需要图形库)
```bash
# 安装系统依赖 (解决 libGL.so.1 错误)
sudo apt install libgl1-mesa-glx libglib2.0-0 libsm6 libxext6 libxrender-dev libgomp1 -y

# 安装 Python 依赖
pip3 install rapidocr-onnxruntime

# 验证安装
python3 -c "from rapidocr_onnxruntime import RapidOCR; print('OCR 安装成功')"

# 启动 OCR 服务器
pm2 start paddle_ocr_server.js --name "ocr-server"
```

### 3. 配置 OCR 服务器地址
在 `config.json` 中添加：
```json
{
  "accounts": [
    {
      "ocrServerUrl": "http://localhost:9004",  // 轻量级: 9004, RapidOCR: 9003
      "ocrBlockedKeywords": ["广告", "违规内容"]
    }
  ]
}
```

**服务端口说明：**
- **轻量级 OCR**: `http://localhost:9004` (推荐)
- **RapidOCR**: `http://localhost:9003` (需要图形库)

## 🚀 启动服务

### 方法1: 使用 PM2 (推荐)

#### 启动 Bot
```bash
pm2 start dist-bot/index.js --name "discord-bot"
```

#### 启动管理界面 (可选)
```bash
pm2 start dist-server/index.js --name "discord-web" --env PORT=3000
```

#### 保存配置
```bash
pm2 save
pm2 list
```

#### 设置开机自启
```bash
pm2 startup
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp $HOME
```

### 方法2: 使用 systemd

#### 创建 Bot 服务文件
```bash
sudo nano /etc/systemd/system/discord-bot.service
```

内容：
```ini
[Unit]
Description=Discord Forwarder Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/discord-forwarder
ExecStart=/usr/bin/node dist-bot/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

#### 重新加载 systemd
```bash
sudo systemctl daemon-reload
sudo systemctl enable discord-bot
sudo systemctl start discord-bot
```

#### 检查状态
```bash
sudo systemctl status discord-bot
```

## 📊 监控和维护

### PM2 常用命令
```bash
# 查看所有进程
pm2 list

# 查看日志
pm2 logs discord-bot
pm2 logs ocr-server

# 重启服务
pm2 restart discord-bot

# 停止服务
pm2 stop discord-bot

# 删除进程
pm2 delete discord-bot
```

### 日志查看
```bash
# 查看 Bot 日志
tail -f ~/.pm2/logs/discord-bot-out.log

# 查看错误日志
tail -f ~/.pm2/logs/discord-bot-error.log
```

### 系统监控
```bash
# 查看系统资源使用
htop
# 或
top

# 查看磁盘使用
df -h

# 查看内存使用
free -h
```

## 🔒 安全配置

### 1. 创建专用用户
```bash
sudo useradd -m -s /bin/bash discord
sudo usermod -aG sudo discord
su - discord
```

### 2. 防火墙配置
```bash
# 只开放必要端口
sudo ufw allow 22/tcp
sudo ufw allow 3000/tcp  # 如果使用管理界面
sudo ufw --force enable
```

### 3. 文件权限
```bash
# 设置配置文件权限
chmod 600 config.json
chmod 600 .env
```

## 🔄 更新部署

### 1. 备份当前配置
```bash
cp config.json config.json.backup
```

### 2. 拉取最新代码
```bash
git pull origin main
```

### 3. 重新构建
```bash
pnpm install
pnpm build:bot
pnpm build:server
```

### 4. 重启服务
```bash
pm2 restart all
```

## 🆘 故障排除

### Bot 无法启动
```bash
# 检查日志
pm2 logs discord-bot

# 检查 Node.js 版本
node --version

# 检查配置文件
cat config.json
```

### OCR 功能异常
```bash
# 检查 OCR 服务器状态
pm2 status ocr-server

# 检查 OCR 服务器日志
pm2 logs ocr-server

# 测试 OCR 服务
curl http://localhost:9003/ocr
```

### 内存不足
```bash
# 检查内存使用
free -h

# 清理系统缓存
sudo apt autoremove
sudo apt autoclean
```

### 网络连接问题
```bash
# 测试网络连接
ping google.com

# 检查 DNS
nslookup discord.com
```

## 📞 支持

如果遇到问题，请提供以下信息：
1. 操作系统版本
2. Node.js 版本
3. PM2 状态输出
4. 错误日志
5. 配置文件（敏感信息请脱敏）
