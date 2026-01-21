# Discord→Telegram 转发实现指南

## 需要修改的文件

### 1. src/bot.ts

在 `processAndSend` 函数中，在 Feishu 转发逻辑之后添加 Telegram 转发逻辑：

```typescript
// 添加在文件顶部的导入
import { getTelegramBridgeClient } from "./index.js";

// 在 processAndSend 函数的 Feishu 转发之后添加
// Telegram 转发
const telegramMappings = this.config.telegramConfig?.mappings || [];
const discordToTelegramMappings = telegramMappings.filter(
  (m: any) => m.type === 'discord-to-telegram' && m.sourceChannelId === message.channelId
);

if (discordToTelegramMappings.length > 0) {
  const bridgeClient = getTelegramBridgeClient();
  if (bridgeClient) {
    for (const mapping of discordToTelegramMappings) {
      try {
        const messageData = {
          channelId: message.channelId,
          message: {
            id: message.id,
            content: finalContent, // 使用已处理的内容
            author: {
              username: username,
              avatarURL: avatarUrl,
            },
            attachments: uploads.map((u) => ({
              url: u.url,
              contentType: u.isImage ? 'image' : 'file',
              name: u.filename,
            })),
            embeds: message.embeds,
          },
        };

        await bridgeClient.handleDiscordMessage(messageData);
        this.logger.info(
          `${logPrefix} [TELEGRAM] 转发到 Telegram 成功 (chat=${mapping.targetChannelId})`
        );
      } catch (err: any) {
        this.logger.error(
          `${logPrefix} [TELEGRAM] 转发失败: ${String(err?.message || err)}`
        );
      }
    }
  } else {
    this.logger.warn(`${logPrefix} [TELEGRAM] Telegram Bridge 客户端未初始化`);
  }
}
```

### 2. telegram_bridge/src/telegram_bridge/forwarder.py

需要确保 `handle_discord_message` 方法正确实现。检查以下内容：

1. 接收 Discord 消息数据
2. 根据 `telegramConfig.mappings` 查找对应的 Telegram chat ID
3. 调用 Bot Manager 或 Client Manager 发送消息
4. 处理附件下载和上传

### 3. 测试步骤

1. 编译 TypeScript 代码：`pnpm build:bot`
2. 启动后端：`pnpm backend`
3. 在 Discord 发送测试消息
4. 检查日志中的 `[TELEGRAM]` 标记
5. 验证消息是否出现在 Telegram 频道

## 已完成的工作

✅ IPC 客户端已创建 (`src/telegramBridgeClient.ts`)
✅ 客户端在 `index.ts` 中初始化
✅ 导出函数已添加 (`getTelegramBridgeClient()`)

## 下一步

由于代码量较大，建议分两次完成：

**第一次**：实现基础的文本消息转发
**第二次**：添加附件和高级功能支持
