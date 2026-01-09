# OCR 自动启用/禁用功能测试

## 功能说明

现在OCR功能会**自动根据屏蔽词列表的配置启用或禁用**：

- ✅ **有屏蔽词时自动启用**：只要 `ocrBlockedKeywords` 列表不为空，OCR功能会自动启用
- ⏸️ **无屏蔽词时自动禁用**：当 `ocrBlockedKeywords` 为空或未配置时，OCR功能会自动禁用

这样可以节省服务器资源，避免不必要的OCR调用。

## 测试步骤

### 测试1：自动启用OCR功能

1. **打开管理界面**：访问 `http://localhost:3000`

2. **配置屏蔽词**：
   - 找到"屏蔽关键词"部分
   - 输入测试屏蔽词，例如：`测试一下`
   - 按回车添加

3. **观察状态显示**：
   - 看到"OCR 图片文字识别"状态变为：`✅ 已启用（检测到屏蔽词）`
   - 说明OCR功能已自动启用

4. **发送测试图片**：
   - 在Discord中发送包含"测试一下"文字的图片
   - 查看Bot控制台日志

**预期日志：**
```
[Bot] ✅ OCR已自动启用（新增1个屏蔽词），服务器URL: http://localhost:9003
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
```

### 测试2：自动禁用OCR功能

1. **清空屏蔽词列表**：
   - 在"屏蔽关键词"部分，点击每个关键词旁的 ✕ 删除
   - 确保列表为空

2. **观察状态显示**：
   - 看到"OCR 图片文字识别"状态变为：`⏸️ 未启用（未配置屏蔽词）`
   - 说明OCR功能已自动禁用

3. **发送测试图片**：
   - 在Discord中发送任意图片
   - 查看Bot控制台日志

**预期日志：**
```
[Bot] ⏸️ OCR已自动禁用（屏蔽词已清空）
[USER] [FILTER] User ID filter passed (allowed=0 muted=0)
[USER] [FILTER] No keyword filter configured, passing
[USER] [SEND] Preparing to send message...
```

**注意：** 此时不会看到 `[OCR]` 相关的日志，说明OCR已禁用

### 测试3：动态切换OCR状态

1. **添加屏蔽词**：
   - 添加 `广告` 到屏蔽词列表
   - 状态变为：`✅ 已启用（检测到屏蔽词）`

2. **立即发送图片**：
   - 发送包含"广告"的图片
   - 应该被OCR检测并阻止

3. **删除屏蔽词**：
   - 删除 `广告` 屏蔽词
   - 状态变为：`⏸️ 未启用（未配置屏蔽词）`

4. **再次发送图片**：
   - 发送包含"广告"的图片
   - 应该直接转发，不再进行OCR检测

## 配置热更新

OCR状态会在**配置更新时自动切换**，无需重启Bot：

- 在Web界面添加/删除屏蔽词
- 保存配置后，Bot会自动重新检测OCR状态
- 有/无屏蔽词时会立即生效

## 状态指示器

在Web界面的"基础设置"区域，"OCR 图片文字识别"部分会显示当前状态：

- `✅ 已启用（检测到屏蔽词）` - OCR功能正常工作
- `⏸️ 未启用（未配置屏蔽词）` - OCR功能已禁用，节省资源

## 性能优势

**自动禁用机制带来的好处：**

1. **节省资源**：
   - 无需OCR时不启动OCR客户端
   - 不调用OCR服务器
   - 减少网络请求和CPU使用

2. **提高速度**：
   - 图片直接转发，无需等待OCR识别
   - 延迟更低，转发更快

3. **降低成本**：
   - 如果使用付费OCR服务，无屏蔽词时不会产生费用
   - 仅在需要时才调用OCR API

## 完整配置示例

### 示例1：启用OCR（有屏蔽词）

```json
{
  "accounts": [
    {
      "id": "账号1",
      "name": "广告过滤账号",
      "type": "selfbot",
      "token": "你的Discord Token",
      "loginRequested": true,
      "ocrServerUrl": "http://localhost:9003",
      "ocrBlockedKeywords": ["广告", "推广", "垃圾信息"],
      "channelWebhooks": {
        "频道ID": "Webhook URL"
      }
    }
  ]
}
```

Bot日志：
```
[Bot] ✅ OCR已自动启用（新增3个屏蔽词），服务器URL: http://localhost:9003
```

### 示例2：禁用OCR（无屏蔽词）

```json
{
  "accounts": [
    {
      "id": "账号2",
      "name": "纯转发账号",
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

Bot日志：
```
[Bot] ⏸️ OCR已自动禁用（屏蔽词已清空）
```

**注意：** 即使配置了 `ocrServerUrl`，只要 `ocrBlockedKeywords` 为空，OCR功能就不会启用。

## 故障排除

### Q1: 添加了屏蔽词但OCR没有启用？

**检查清单：**
1. 查看Bot控制台是否有 `✅ OCR已自动启用` 的提示
2. 确认屏蔽词数组不为空
3. 确认OCR服务器正常运行

### Q2: 删除了屏蔽词但OCR仍在启用？

**检查清单：**
1. 查看Bot控制台是否有 `⏸️ OCR已自动禁用` 的提示
2. 确认 `ocrBlockedKeywords` 数组为空 `[]`
3. 重新保存配置触发热更新

### Q3: 状态显示不正确？

**解决方法：**
1. 刷新Web界面
2. 确认配置已成功保存
3. 检查Bot日志中的OCR状态提示

## 日志级别

所有OCR相关的状态变化都会输出到控制台：

- `[Bot] ✅ OCR已自动启用` - OCR功能已启用
- `[Bot] ⏸️ OCR已自动禁用` - OCR功能已禁用
- `[Bot] ⏸️  OCR已自动禁用（未配置OCR服务器URL）` - OCR服务器URL未配置

这些日志可以帮助你快速诊断OCR功能状态。
