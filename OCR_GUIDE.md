# OCR 图片文字识别功能使用指南

## 功能说明

OCR功能可以自动识别Discord消息中的图片文字，并根据配置的屏蔽词过滤内容。如果图片中包含屏蔽词，则该消息不会被转发。

## 配置方式

### 1. 配置OCR服务器

在 `config.json` 中每个账号配置：

```json
{
  "accounts": [
    {
      "id": "账号ID",
      "name": "账号名称",
      "ocrServerUrl": "http://localhost:9003",
      "ocrBlockedKeywords": ["测试一下", "广告", "垃圾信息"]
    }
  ]
}
```

**配置项说明：**

- `ocrServerUrl`: OCR服务器的完整URL（必须包含协议和端口）
- `ocrBlockedKeywords`: 屏蔽词列表，如果图片文字中包含这些词，则不会转发

**自动启用/禁用机制：**

- ✅ **有屏蔽词时自动启用**：只要 `ocrBlockedKeywords` 列表不为空，OCR功能会自动启用
- ⏸️ **无屏蔽词时自动禁用**：当 `ocrBlockedKeywords` 为空或未配置时，OCR功能会自动禁用，节省服务器资源

**使用示例：**

```json
{
  "accounts": [
    {
      "id": "账号1",
      "name": "广告过滤账号",
      "ocrServerUrl": "http://localhost:9003",
      "ocrBlockedKeywords": ["广告", "垃圾", "推广"],
      "channelWebhooks": { "频道ID": "Webhook URL" }
    }
  ]
}
```

这个配置会自动启用OCR，检测包含"广告"、"垃圾"、"推广"的图片。

```json
{
  "accounts": [
    {
      "id": "账号2",
      "name": "普通转发账号",
      "channelWebhooks": { "频道ID": "Webhook URL" }
    }
  ]
}
```

这个配置不会启用OCR（因为 `ocrBlockedKeywords` 未配置），适合只需要普通转发的场景。

### 2. OCR服务器要求

OCR服务器需要提供一个HTTP POST接口：

**端点：** `/ocr`

**请求格式：** `multipart/form-data`

**请求字段：**
- `image`: 图片文件（二进制）

**响应格式：** JSON

**响应示例：**
```json
{
  "code": 0,
  "msg": "success",
  "data": [
    {
      "box": [[x1, y1], [x2, y2], [x3, y3], [x4, y4]],
      "score": 0.95,
      "text": "识别到的文字"
    }
  ]
}
```

## 启动和测试

### 1. 编译Bot代码

```bash
pnpm run build:bot
```

### 2. 启动Bot

```bash
pnpm run start:bot
```

### 3. 验证OCR功能

启动Bot后，查看控制台日志，应该看到以下信息：

```
[Bot] OCR客户端已初始化，服务器URL: http://localhost:9003，屏蔽词数: 1
```

当收到包含图片的消息时，会看到详细的OCR日志：

```
[OCR] 消息包含 1 个附件，开始检测图片...
[OCR] 检测到图片 image.png (类型: image/png)
[OCR] 开始OCR识别...
[OCR] 开始识别图片: https://cdn.discordapp.com/...
[OCR] 步骤1: 下载图片...
[OCR] 图片下载完成，大小: 123456 bytes
[OCR] 步骤2: 调用OCR服务器 http://localhost:9003...
[OCR] 识别完成，检测到 3 个文本块
[OCR] 识别到的文字: "这是测试图片的内容"
[OCR] 图片检测通过，未检测到敏感词
[OCR] 图片检测完成，总图片数=1，已检测=1，允许转发
```

如果检测到屏蔽词：

```
[OCR] 图片检测通过，未检测到敏感词
[OCR] 识别到的文字: "这是广告信息"
[OCR] [USER] [OCR] 检测到敏感文字 "广告"，跳过转发
```

## 性能优化

### 4G4H服务器优化建议

1. **OCR服务器选择**
   - 推荐使用PaddleOCR或Tesseract OCR轻量级方案
   - 避免使用过于复杂的大模型

2. **图片大小限制**
   - 当前代码已经限制最大下载15MB
   - 可根据实际情况调整OCR服务器的图片处理能力

3. **并发控制**
   - Bot会按顺序处理每张图片
   - 如果消息包含多张图片，会逐张检测

4. **超时设置**
   - 下载超时：30秒
   - OCR调用超时：60秒
   - 可根据网络情况调整

## 调试方法

### 1. 查看详细日志

所有OCR相关的操作都会输出到控制台，包括：
- OCR服务器连接状态
- 图片下载进度
- OCR识别结果
- 关键词匹配情况

### 2. 检查OCR服务器状态

确保OCR服务器正常运行：

```bash
curl http://localhost:9003/ocr
# 或
curl -X POST http://localhost:9003/ocr -F "image=@test.jpg"
```

### 3. 验证屏蔽词

在配置中添加测试屏蔽词：

```json
{
  "ocrBlockedKeywords": ["测试", "广告"]
}
```

然后发送包含这些文字的图片，查看日志是否正确识别和过滤。

## 常见问题

### Q1: OCR功能没有触发？

**检查清单：**
1. `ocrServerUrl` 是否正确配置
2. `ocrBlockedKeywords` 是否有内容
3. OCR服务器是否正常运行
4. Bot日志中是否有"OCR客户端已初始化"的提示

### Q2: OCR识别失败？

**可能原因：**
1. OCR服务器未启动
2. 网络连接问题
3. OCR服务器返回格式不正确

**解决方法：**
1. 检查OCR服务器日志
2. 查看Bot控制台错误信息
3. 测试OCR服务器接口是否正常

### Q3: 屏蔽词不准确？

**优化建议：**
1. 使用完整的关键词，而不是部分匹配
2. 避免使用过于通用的词
3. 考虑使用正则表达式（需要在OCR服务器端实现）

## 技术实现

### 核心流程

1. **消息接收** → Bot监听到Discord消息
2. **附件检测** → 检查是否包含图片
3. **图片下载** → 从Discord CDN下载图片
4. **OCR识别** → 调用OCR服务器识别文字
5. **关键词匹配** → 检查识别结果是否包含屏蔽词
6. **转发决策** → 根据匹配结果决定是否转发

### 性能特点

- **异步处理**：不会阻塞其他消息的转发
- **错误隔离**：单个图片识别失败不影响其他图片
- **详细日志**：每个步骤都有日志输出，方便调试

## 配置示例

完整配置示例：

```json
{
  "accounts": [
    {
      "id": "账号ID",
      "name": "测试账号",
      "type": "selfbot",
      "token": "你的Discord Token",
      "loginRequested": true,
      "ocrServerUrl": "http://your-ocr-server.com:9003",
      "ocrBlockedKeywords": [
        "广告",
        "垃圾信息",
        "测试屏蔽词"
      ],
      "channelWebhooks": {
        "来源频道ID": "目标Webhook URL"
      }
    }
  ],
  "activeId": "账号ID"
}
```

## 测试工具

项目包含 `test_ocr.js` 测试脚本，可以独立测试OCR功能：

```bash
node test_ocr.js
```

该脚本会：
1. 测试OCR服务器连接
2. 下载测试图片
3. 调用OCR识别
4. 测试关键词匹配

## 更新日志

- ✅ 增强了OCR日志输出，每个步骤都有详细日志
- ✅ 添加了OCR客户端初始化确认日志
- ✅ 优化了错误处理，不会因单个图片失败而影响整体
- ✅ 改进了关键词匹配逻辑
