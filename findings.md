# Telegram 规则持久化问题诊断

## 问题描述
Discord→Telegram 转发规则在刷新后，规则行保留但字段值（sourceChannelId, targetChannelId, note）变为空。

## 关键发现

### 1. 加载时的数据状态
```json
{
  "id": "28c1db71-54f7-4457-a7c0-c4d21d6c1839",
  "sourceChannelId": "",  // 空字符串
  "targetChannelId": "",  // 空字符串
  "note": "",             // 空字符串
  "type": "discord-to-telegram",
  "translate": false,
  "translateDirection": "auto"
}
```

**观察：**
- 规则对象存在（id 正确）
- 但所有可编辑字段值都是空字符串

### 2. 前端更新正常
```
[DEBUG] 更新 Telegram 规则: 0 sourceChannelId 321
[DEBUG] 更新 Telegram 规则: 0 targetChannelId 321
[DEBUG] 更新 Telegram 规则: 0 note 321
```

**观察：**
- `updateMapping` 函数被正确调用
- 字段值被正确更新到内存中的 state 对象

### 3. 可能的根本原因

#### 假设 A：防抖延迟导致数据未保存
`saveConfig` 函数使用 800ms 防抖延迟：
```javascript
saveTimer = setTimeout(async () => {
  // 保存逻辑
}, 800);
```

**如果用户在填写完字段后立即刷新页面（< 800ms），数据不会被保存！**

#### 假设 B：后端数据处理问题
后端的 `normalizeAccount` 函数可能在处理 `telegramConfig.mappings` 时，由于类型检查失败而将字段值重置为空字符串。

## 待验证

### 需要的日志
1. **保存时的日志**：`[DEBUG] 保存 telegramConfig:` - 查看发送到后端的数据
2. **后端日志**：查看 `config.json` 文件中实际保存的数据

### 验证步骤
1. 填写字段
2. **等待 2 秒**（确保防抖完成）
3. 检查保存日志
4. 刷新页面
5. 检查加载日志
6. 对比两个日志

## 已完成的修复

### 1. 后端 API 修复
- ✅ 添加 `telegramConfig` 到 `FrontendAccount` 接口
- ✅ 修改 `accountToFrontend` 返回 `telegramConfig`
- ✅ 修改 `dtoToAccount` 保存 `telegramConfig`

### 2. 前端修复
- ✅ 修改 `addMapping` 支持 `telegramConfig.mappings`
- ✅ 修改 `updateMapping` 支持 `telegramConfig.mappings`
- ✅ 修改 `removeMapping` 支持 `telegramConfig.mappings`
- ✅ 修改 `renderMappings` 读取 `telegramConfig.mappings`
- ✅ 添加调试日志

### 3. **根本原因修复（关键！）**
- ✅ **发现问题**：`updateMapping` 函数在更新 Telegram 规则后没有调用保存函数
- ✅ **添加立即保存**：为关键字段（sourceChannelId, targetChannelId, note）添加立即保存
- ✅ **代码位置**：`public/index.html` lines 1691-1696

### 4. **Discord Bot 启动验证修复**
- ✅ **发现问题**：Bot 启动时只检查 `channelWebhooks`，不认可 Telegram 转发规则
- ✅ **修复方案**：修改 `buildSenderBots` 函数的验证逻辑，接受 Telegram 转发规则
- ✅ **代码位置**：`src/index.ts` lines 117-127
- ✅ **影响**：现在配置了 Discord→Telegram 规则后可以正常启动 Discord bot

**修复前的代码：**
```javascript
if (acc.telegramConfig.mappings[idx]) {
  acc.telegramConfig.mappings[idx][field] = value;
  console.log('[DEBUG] 更新 Telegram 规则:', idx, field, value);
}
// 没有保存调用！
```

**修复后的代码：**
```javascript
if (acc.telegramConfig.mappings[idx]) {
  acc.telegramConfig.mappings[idx][field] = value;
  console.log('[DEBUG] 更新 Telegram 规则:', idx, field, value);
}
// 立即保存关键字段
if (['sourceChannelId', 'targetChannelId', 'note'].includes(field)) {
  saveConfigImmediate();
} else {
  saveConfig();
}
```

## 新发现的问题

### Discord→Telegram 转发未实现

**症状：**
- Discord→Discord 转发正常工作
- Discord→Telegram 规则配置成功，但消息不会转发到 Telegram

**根本原因：**
`src/bot.ts` 的 `processAndSend` 函数中只实现了：
- ✅ Discord→Discord（通过 `senderForThis`）
- ✅ Discord→Feishu（通过 `feishuSenderForThis`）
- ❌ Discord→Telegram（**完全未实现**）

**架构分析：**
1. Telegram Bridge 是独立的 Python 进程
2. 使用 JSON-RPC over stdio 进行IPC 通信
3. 入口文件：`telegram_bridge/src/telegram_bridge/ipc.py`
4. Bot 需要通过 stdin 向 Bridge 发送 JSON 消息

**需要实现的功能：**
1. 在 `bot.ts` 中检查 `telegramConfig.mappings`
2. 为匹配的源频道创建 Telegram 发送逻辑
3. 通过 stdio 向 Telegram Bridge 发送 JSON-RPC 请求
4. 处理 Bridge 的响应

**相关文件：**
- `src/bot.ts` - 需要添加 Telegram 转发逻辑
- `src/processManager.ts` - Telegram Bridge 进程管理
- `telegram_bridge/src/telegram_bridge/ipc.py` - IPC 通信协议
- `telegram_bridge/src/telegram_bridge/main.py` - Bridge 入口点

### 方案 1：移除防抖延迟（推荐）
对于关键字段更新，立即保存而不使用防抖：
```javascript
function updateMapping(idx, field, value) {
  // ... 更新逻辑
  saveConfigImmediate(); // 立即保存
}
```

### 方案 2：增加保存提示
在 UI 上显示"保存中..."状态，让用户知道何时可以安全刷新。

### 方案 3：使用 localStorage 作为备份
在更新字段时同时保存到 localStorage，刷新时优先从 localStorage 恢复。
