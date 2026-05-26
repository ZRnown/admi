# Discord↔Telegram 双向转发测试指南

## 编译和启动

### 1. 编译 TypeScript 代码
```bash
pnpm build:bot
```

### 2. 启动后端
```bash
pnpm backend
```

这会启动：
- Discord Bot
- OCR Server
- Telegram Bridge (Python)

## 测试前的配置

### 1. 配置 Telegram Bot
在 Web UI 中：
1. 打开账号的 "Telegram Bot" 标签页
2. 输入 Telegram Bot Token
3. 点击 "连接" 按钮
4. 等待状态变为 "在线"

### 2. 配置转发规则

#### Discord→Telegram 规则
1. 切换到 "Discord → Telegram 转发规则" 标签
2. 点击 "添加规则"
3. 填写：
   - 源频道 ID（Discord channel ID）
   - 目标频道 ID（Telegram chat ID）
   - 备注（可选）
4. 保存后刷新确认规则存在

#### Telegram→Discord 规则
1. 切换到 "Telegram → Discord 转发规则" 标签
2. 点击 "添加规则"
3. 填写：
   - 源频道 ID（Telegram chat ID）
   - 目标频道 ID（Discord channel ID - webhook URL）
   - 备注（可选）
4. 保存

## 测试步骤

### 测试 1: Discord→Telegram 文本消息
1. 在配置的 Discord 源频道发送消息："测试 Discord→Telegram"
2. 检查后端日志是否有：
   ```
   [TELEGRAM] 转发到 Telegram 成功
   ```
3. 检查 Telegram 目标频道是否收到消息

### 测试 2: Discord→Telegram 图片
1. 在 Discord 源频道发送一张图片
2. 检查日志：
   ```
   [TELEGRAM] 转发到 Telegram 成功 (attachments=1)
   ```
3. 确认 Telegram 收到图片

### 测试 3: Telegram→Discord 文本消息
1. 在配置的 Telegram 源频道发送消息
2. 检查 Telegram Bridge 日志：
   ```
   Received Telegram message from account xxx
   ```
3. 检查 Discord 目标频道是否收到消息

### 测试 4: Telegram→Discord 图片
1. 在 Telegram 源频道发送图片
2. 检查日志确认转发
3. 确认 Discord 收到图片

## 常见问题排查

### Discord→Telegram 不工作

**检查项**:
1. Telegram Bot 是否在线？
   - 查看 Web UI Telegram Bot 状态

2. 转发规则是否正确？
   - 刷新页面确认规则存在
   - 确认源频道 ID 和目标频道 ID 正确

3. 检查后端日志：
   ```bash
   tail -f logs/*.log | grep TELEGRAM
   ```

4. IPC 客户端是否初始化？
   - 查找日志：`Telegram Bridge IPC client initialized`

### Telegram→Discord 不工作

**检查项**:
1. Telegram Bot 是否有权限读取频道消息？
   - 确保 Bot 在频道中
   - 确保 Bot 有读取消息权限

2. Discord webhook 是否正确？
   - 测试 webhook URL 是否有效

3. 检查 Telegram Bridge 日志：
   ```bash
   # 查看 Python 日志
   tail -f telegram_bridge/logs/*.log
   ```

4. 消息处理器是否注册？
   - 查找日志：`Registered message handler for Telegram account`

## 日志关键词

| 功能 | 日志关键词 |
|------|----------|
| IPC 初始化 | `Telegram Bridge IPC client initialized` |
| Discord→Telegram | `[TELEGRAM] 转发到 Telegram` |
| Telegram 消息接收 | `Received Telegram message from account` |
| Telegram→Discord | `Forwarding Telegram message to Discord` |
| 配置更新 | `Registered message handler for Telegram account` |

## 调试模式

如果需要更详细的日志，可以：

1. 修改 `src/logger.ts` 设置日志级别为 `debug`
2. 修改 `telegram_bridge/src/telegram_bridge/main.py` 设置 loguru 级别为 `DEBUG`
3. 重新编译和启动

## 已知限制

1. **附件处理**：
   - Discord→Telegram：直接发送附件 URL
   - Telegram→Discord：需要实现文件下载（当前为占位符）

2. **大文件**：
   - 受 Telegram 和 Discord 文件大小限制约束

3. **特殊消息类型**：
   - Sticker、Voice 等特殊类型支持有限
