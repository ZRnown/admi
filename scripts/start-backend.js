#!/usr/bin/env node

/**
 * 后端统一启动脚本
 * 自动启动：Bot + OCR 服务器 + Telegram Bridge（由 Bot 自动管理）
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const processes = [];
let isShuttingDown = false;

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function log(prefix, message, color = colors.reset) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`${color}[${timestamp}] [${prefix}]${colors.reset} ${message}`);
}

// 优雅退出处理
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log('SHUTDOWN', `收到 ${signal} 信号，正在关闭所有服务...`, colors.yellow);

  processes.forEach((proc, index) => {
    if (proc && !proc.killed) {
      log('SHUTDOWN', `正在停止进程 ${index + 1}...`, colors.yellow);
      proc.kill('SIGTERM');
    }
  });

  setTimeout(() => {
    log('SHUTDOWN', '所有服务已关闭', colors.green);
    process.exit(0);
  }, 2000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 检查并清理端口
function killProcessOnPort(port) {
  try {
    const result = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
    if (result) {
      const pids = result.split('\n').filter(pid => pid);
      pids.forEach(pid => {
        try {
          log('CLEANUP', `正在停止占用端口 ${port} 的进程 (PID: ${pid})...`, colors.yellow);
          execSync(`kill -9 ${pid}`);
          log('CLEANUP', `进程 ${pid} 已停止`, colors.green);
        } catch (e) {
          // 进程可能已经停止
        }
      });
      return true;
    }
  } catch (e) {
    // 端口未被占用
  }
  return false;
}

// 主启动函数
async function startBackend() {
  log('STARTUP', '开始启动后端服务...', colors.bright + colors.cyan);

  // 步骤 1: 编译 Bot
  log('BUILD', '正在编译 Bot...', colors.blue);
  try {
    execSync('pnpm build:bot', { stdio: 'inherit', cwd: path.resolve(__dirname, '..') });
    log('BUILD', 'Bot 编译完成 ✓', colors.green);
  } catch (error) {
    log('BUILD', 'Bot 编译失败 ✗', colors.red);
    process.exit(1);
  }

  // 步骤 2: 启动 OCR 服务器
  log('OCR', '正在启动 OCR 服务器...', colors.blue);

  // 清理端口 9003
  killProcessOnPort(9003);

  const ocrServer = spawn('node', ['paddle_ocr_server.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  processes.push(ocrServer);

  ocrServer.stdout.on('data', (data) => {
    log('OCR', data.toString().trim(), colors.cyan);
  });

  ocrServer.stderr.on('data', (data) => {
    log('OCR', data.toString().trim(), colors.yellow);
  });

  ocrServer.on('exit', (code) => {
    if (!isShuttingDown) {
      log('OCR', `OCR 服务器退出，代码: ${code}`, colors.red);
    }
  });

  // 等待 OCR 服务器启动
  await new Promise(resolve => setTimeout(resolve, 2000));
  log('OCR', 'OCR 服务器已启动 ✓', colors.green);

  // 步骤 3: 启动 Bot（会自动启动 Telegram Bridge）
  log('BOT', '正在启动 Bot...', colors.blue);
  const bot = spawn('node', ['dist-bot/index.js'], {
    cwd: path.resolve(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  processes.push(bot);

  bot.stdout.on('data', (data) => {
    log('BOT', data.toString().trim(), colors.green);
  });

  bot.stderr.on('data', (data) => {
    log('BOT', data.toString().trim(), colors.yellow);
  });

  bot.on('exit', (code) => {
    if (!isShuttingDown) {
      log('BOT', `Bot 退出，代码: ${code}`, colors.red);
      gracefulShutdown('BOT_EXIT');
    }
  });

  log('STARTUP', '所有后端服务已启动 ✓', colors.bright + colors.green);
  log('INFO', 'Bot 会自动管理 Telegram Bridge 进程', colors.cyan);
  log('INFO', '按 Ctrl+C 停止所有服务', colors.cyan);
}

// 启动
startBackend().catch((error) => {
  log('ERROR', error.message, colors.red);
  process.exit(1);
});
