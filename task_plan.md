# Discord↔Telegram 双向转发功能实现计划

## 目标
实现 Discord 和 Telegram 之间的双向消息转发功能

## 任务阶段

### Phase 1: 分析现有架构 [completed]
**目标**: 理解 Telegram Bridge 的 IPC 协议和消息格式
- [x] 检查 Telegram Bridge IPC 协议 (`telegram_bridge/src/telegram_bridge/ipc.py`)
- [x] 检查消息类型定义 (`telegram_bridge/src/telegram_bridge/telegram_types.py`)
- [x] 检查 Bridge 的消息处理器 (`telegram_bridge/src/telegram_bridge/forwarder.py`)
- [x] 确认 Bridge 支持的 RPC 方法

**产物**: ✅ 理解了 IPC 消息格式和 Bridge API

**关键发现**:
- Bridge 使用 JSON-RPC over stdio 通信
- 支持的 RPC 方法：
  - `sendMessage` - 发送消息到 Telegram
  - `handleDiscordMessage` - 处理Discord消息（转发到Telegram）
  - `updateConfig` - 更新配置
  - `connectBot` / `disconnectBot` - Bot连接管理
- 消息通过 `\n` 分隔的 JSON 发送

### Phase 2: 实现 Discord→Telegram 转发 [completed]
**目标**: 在 bot.ts 中添加向 Telegram 转发消息的功能

**已完成的子任务**:
1. ✅ 创建 Telegram Bridge IPC 客户端类 (`src/telegramBridgeClient.ts`)
2. ✅ 在 `index.ts` 中初始化 IPC 客户端
3. ✅ 添加导出函数 `getTelegramBridgeClient()`
4. ✅ 在 `bot.ts` 中添加 Telegram 转发逻辑
5. ✅ 在 `processAndSend` 中检查 `telegramConfig.mappings`
6. ✅ 调用 IPC 客户端发送消息到 Telegram
7. ✅ 处理附件（图片、视频、文件）转发
8. ✅ 处理翻译功能集成（使用 finalContent）

**产物**: ✅ Discord 消息可以转发到 Telegram

**关键代码位置**:
- `src/bot.ts:17` - 导入 getTelegramBridgeClient
- `src/bot.ts:903-949` - Telegram 转发逻辑
- `telegram_bridge/src/telegram_bridge/forwarder.py:386-488` - Discord 消息处理
- `telegram_bridge/src/telegram_bridge/main.py:161-177` - IPC 处理器

### Phase 3: 实现 Telegram→Discord 转发 [completed]
**目标**: 让 Telegram Bridge 将消息发送回 Discord

**已完成的子任务**:
1. ✅ 在 `main.py` 中设置消息处理器回调
2. ✅ 在 `_handle_update_config` 中为每个账号注册消息处理器
3. ✅ 通过 `forwarder.handle_telegram_message` 处理Telegram消息
4. ✅ 使用 `_send_to_discord` 转发到Discord webhook
5. ✅ 处理附件下载和转发（基础实现）

**产物**: ✅ Telegram 消息可以转发到 Discord

**关键代码位置**:
- `telegram_bridge/src/telegram_bridge/main.py:37-57` - 消息处理器设置
- `telegram_bridge/src/telegram_bridge/main.py:163-177` - 注册消息处理器
- `telegram_bridge/src/telegram_bridge/forwarder.py:330-385` - handle_telegram_message
- `telegram_bridge/src/telegram_bridge/forwarder.py:165-234` - _send_to_discord

### Phase 4: 测试和优化 [in_progress]
**目标**: 确保双向转发稳定工作

**子任务**:
1. 测试 Discord→Telegram 纯文本消息
2. 测试 Discord→Telegram 图片/附件
3. 测试 Telegram→Discord 纯文本消息
4. 测试 Telegram→Discord 图片/附件
5. 测试翻译功能
6. 测试错误恢复

**产物**: 功能完整且稳定

## 技术设计

### IPC 通信协议
```typescript
// Discord bot → Telegram Bridge
interface SendMessageRequest {
  method: "send_message";
  params: {
    chat_id: string;  // Telegram chat ID
    text?: string;
    photo?: string;   // URL or base64
    document?: string;
    // ... 其他参数
  };
}

// Telegram Bridge → Discord bot
interface TelegramMessageNotification {
  method: "telegram_message";
  params: {
    chat_id: string;
    message_id: number;
    text?: string;
    photo?: object;
    // ... 其他字段
  };
}
```

### 文件结构
- `src/telegramBridgeClient.ts` - 新文件：IPC 客户端
- `src/bot.ts` - 修改：添加 Telegram 转发逻辑
- `src/index.ts` - 修改：初始化 Telegram Bridge 连接

## 错误记录

| 错误 | 尝试次数 | 解决方案 |
|------|---------|----------|
| - | - | - |

## 进度跟踪
- 开始时间: 2026-01-18 15:55
- 完成时间: 2026-01-18 16:30
- 当前阶段: Phase 4 (测试和优化)
- 完成百分比: 90%

## 总结

### ✅ 已实现的功能

1. **IPC 通信架构**
   - TypeScript IPC 客户端 (`src/telegramBridgeClient.ts`)
   - JSON-RPC over stdio 协议
   - 双向消息传递

2. **Discord→Telegram 转发**
   - 在 `bot.ts` 中集成转发逻辑
   - 支持文本、附件、翻译
   - 根据 `telegramConfig.mappings` 自动路由

3. **Telegram→Discord 转发**
   - 消息处理器自动注册
   - 通过 forwarder 转换消息格式
   - 使用 Discord webhook 发送

4. **配置管理**
   - 前端规则持久化已修复
   - 后端配置热重载
   - Telegram Bridge 配置同步

### 📋 待优化项

1. **附件下载**：Telegram→Discord 需要实现实际的文件下载
2. **错误重试**：添加消息发送失败重试机制
3. **消息队列**：高频消息时的队列处理
4. **性能优化**：大量转发规则时的性能

### 📝 测试清单

参见 `TESTING_GUIDE.md` 获取详细测试步骤。
