# OCR 图片文字识别 - 快速开始

## 功能说明

OCR功能会**自动根据屏蔽词列表的配置启用或禁用**：

- ✅ **有屏蔽词时自动启用**：只要配置了 `ocrBlockedKeywords`，OCR功能会自动启用
- ⏸️ **无屏蔽词时自动禁用**：当 `ocrBlockedKeywords` 为空时，OCR功能会自动禁用，节省资源

## 快速测试

### 方式1：使用管理界面（推荐）

1. **启动Web界面**
   ```bash
   pnpm run dev
   ```
   访问：`http://localhost:3000`

2. **配置OCR**
   - 登录管理界面
   - 在"基础设置"区域找到"OCR 图片文字识别"
   - 配置OCR服务器地址：`http://localhost:9003`
   - 在"屏蔽关键词"下方的"OCR 屏蔽关键词"中添加测试词，例如：`测试一下`
   - 状态会自动显示：`✅ 已启用（检测到屏蔽词）`

3. **启动Bot**
   ```bash
   # 编译Bot
   pnpm run build:bot

   # 启动Bot
   pnpm run start:bot
   ```

4. **验证OCR工作**
   - 在Discord中发送包含"测试一下"文字的图片
   - 查看Bot控制台，应该看到详细的OCR识别日志
   - 如果匹配到屏蔽词，该消息不会被转发

### 方式2：手动测试（推荐）

1. **启动简单的OCR测试服务器**
   ```bash
   pnpm run start:simple-ocr-server
   ```
   这会启动一个简单的HTTP服务器（返回示例数据）

2. **运行OCR测试脚本**
   ```bash
   pnpm run test:ocr
   ```
   这会：
   - 测试OCR服务器连接
   - 下载测试图片
   - 调用OCR识别
   - 测试关键词匹配

3. **查看测试结果**
   ```
   OCR功能测试
   ========================
   OCR服务器: http://localhost:9003

   步骤1: 测试OCR服务器连接...
   ✅ OCR服务器连接成功

   步骤2: 测试图片识别...
   [测试结果...]
   ```

### 方式3：生产环境（使用PaddleOCR）

1. **安装OCR服务器**
   ```bash
   # 方式A：Node.js绑定（性能最好）
   npm install paddleocr onnxruntime-node

   # 方式B：Python后端（准确率最高）
   pip install paddlepaddle paddleocr
   ```

2. **启动PaddleOCR服务器**
   ```bash
   # 方式A
   pnpm run start:paddle-ocr-server

   # 方式B（需要先注释代码中的方式A）
   node paddle_ocr_server.js
   ```

3. **配置Bot使用PaddleOCR服务器**
   - 在管理界面配置OCR服务器地址：`http://localhost:9003`
   - 添加需要屏蔽的关键词

## 配置示例

### 启用OCR的配置

```json
{
  "accounts": [
    {
      "id": "账号ID",
      "name": "广告过滤账号",
      "type": "selfbot",
      "token": "你的Discord Token",
      "loginRequested": true,
      "ocrServerUrl": "http://localhost:9003",
      "ocrBlockedKeywords": [
        "广告",
        "垃圾",
        "推广",
        "测试一下"
      ],
      "channelWebhooks": {
        "频道ID": "Webhook URL"
      }
    }
  ]
}
```

**Bot启动日志：**
```
[Bot] ✅ OCR已自动启用（新增4个屏蔽词），服务器URL: http://localhost:9003
```

### 禁用OCR的配置

```json
{
  "accounts": [
    {
      "id": "账号ID",
      "name": "普通转发账号",
      "type": "selfbot",
      "token": "你的Discord Token",
      "loginRequested": true,
      "ocrServerUrl": "http://localhost:9003",
      "ocrBlockedKeywords": [],
      "channelWebhooks": {
        "频道ID": "Webhook URL"
      }
    }
  ]
}
```

**Bot启动日志：**
```
[Bot] ⏸️  OCR已自动禁用（屏蔽词已清空）
```

**注意：** 即使配置了 `ocrServerUrl`，只要 `ocrBlockedKeywords` 为空，OCR功能就不会启用，节省资源。

## 日志说明

### OCR启用日志

```
[Bot] ✅ OCR已自动启用（新增4个屏蔽词），服务器URL: http://localhost:9003
```

说明：OCR功能已自动启用，检测到4个屏蔽词。

### OCR禁用日志

```
[Bot] ⏸️  OCR已自动禁用（屏蔽词已清空）
```

说明：OCR功能已自动禁用，因为没有配置屏蔽词。

### OCR处理日志（启用时）

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
[OCR] [USER] [OCR] 检测到敏感文字 "测试一下"，跳过转发
[OCR] 图片检测完成，总图片数=1，已检测=1，允许转发
```

说明：
- 下载了图片
- 调用了OCR服务器
- 识别到了文字
- 匹配到屏蔽词，阻止转发

### 无OCR日志（禁用时）

```
[USER] [START] Processing message: channel=xxx id=xxx
[USER] [CONTENT] content="test" ...
[USER] [FILTER] User ID filter passed
[USER] [SEND] Preparing to send message...
```

说明：
- 没有OCR相关日志
- 直接进行转发处理

## 动态配置更新

OCR状态会在**配置更新时自动切换**，无需重启Bot：

1. **添加屏蔽词**：
   - 在Web界面添加关键词
   - 保存配置
   - Bot自动启用OCR
   - 立即生效

2. **删除所有屏蔽词**：
   - 清空屏蔽词列表
   - 保存配置
   - Bot自动禁用OCR
   - 立即生效

3. **部分删除**：
   - 删除部分关键词
   - OCR继续启用（只要还有屏蔽词）

## 性能优势

自动禁用机制带来的好处：

1. **节省CPU资源**
   - 无需OCR时不会启动OCR客户端
   - 不会调用OCR服务器API
   - 降低CPU使用率

2. **节省网络带宽**
   - 无需OCR时不下载图片到Bot服务器
   - 不发送OCR请求

3. **降低延迟**
   - 无需OCR时图片直接转发
   - 无OCR识别等待时间

4. **降低成本**
   - 如果使用付费OCR服务，无屏蔽词时不产生费用
   - 仅在需要时才调用

## 故障排除

### Q1: 添加了屏蔽词但OCR没有启用？

**检查：**
1. 查看Bot控制台是否有 `[Bot] ✅ OCR已自动启用` 的日志
2. 确认屏蔽词数组不为空 `[]`
3. 确认OCR服务器正常运行

**解决方法：**
- 重新保存配置触发热更新
- 检查OCR服务器日志

### Q2: 删除了屏蔽词但OCR仍在启用？

**检查：**
1. 查看Bot控制台是否有 `[Bot] ⏸️  OCR已自动禁用` 的日志
2. 确认屏蔽词数组为空 `[]`

**解决方法：**
- 确保数组完全为空，不是 `[""]`
- 重新保存配置

### Q3: OCR识别不准确？

**优化建议：**
1. 使用PaddleOCR服务器（准确率最高）
2. 调整OCR识别参数（模型选择）
3. 使用更明确的关键词

## 命令速查

```bash
# 编译Bot
pnpm run build:bot

# 启动Bot
pnpm run start:bot

# 运行OCR测试
pnpm run test:ocr

# 启动简单测试OCR服务器
pnpm run start:simple-ocr-server

# 启动PaddleOCR服务器（需要先安装依赖）
pnpm run start:paddle-ocr-server
```

## 4G4H服务器优化建议

### 1. OCR服务器选择

**推荐：PaddleOCR**

- **轻量级模型**：选择适合CPU的模型
- **准确率与性能平衡**：PaddleOCR在低配置服务器上表现优秀
- **中英文混合识别**：适合Discord消息

### 2. 资源限制

- **图片大小限制**：15MB（已配置）
- **超时设置**：
  - 下载超时：30秒
  - OCR调用超时：60秒
  - 避免长时间阻塞

### 3. 并发控制

- **逐张处理**：按顺序处理每张图片
- **异步不阻塞**：OCR识别不影响其他消息转发
- **错误隔离**：单张失败不影响整体

## 详细文档

- **OCR_GUIDE.md** - OCR功能详细指南
- **OCR_AUTO_ENABLE_TEST.md** - 自动启用/禁用测试文档

## 技术支持

如遇到问题，请查看：
1. Bot控制台日志（启动Bot的终端）
2. OCR服务器日志（如有）
3. Web管理界面的状态显示

祝使用愉快！
