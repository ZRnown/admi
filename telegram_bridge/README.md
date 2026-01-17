# Telegram Bridge Service

Telegram桥接服务，为Discord Bot提供Telegram集成功能。

## 功能特性

- Telegram客户端和机器人支持
- 双向消息转发
- Session文件和字符串管理
- IPC通信接口
- 媒体文件处理
- 连接状态监控

## 安装

```bash
pip install -e .
```

## 使用

```bash
python -m telegram_bridge.main
```

## 架构

```
telegram_bridge/
├── src/
│   └── telegram_bridge/
│       ├── __init__.py
│       ├── main.py          # 主入口
│       ├── client.py        # Telegram客户端管理
│       ├── bot.py           # Telegram机器人管理
│       ├── ipc.py           # IPC通信层
│       ├── session.py       # Session管理
│       └── types.py         # 类型定义
├── tests/
├── docs/
├── requirements.txt
└── pyproject.toml
```

## 开发

1. 安装依赖：
   ```bash
   pip install -r requirements.txt
   ```

2. 运行测试：
   ```bash
   python -m pytest tests/
   ```

## API

服务通过JSON-RPC over stdio进行通信。

### 方法

- `connect` - 连接Telegram账号
- `disconnect` - 断开连接
- `sendMessage` - 发送消息
- `getChannels` - 获取频道列表
- `getStatus` - 获取连接状态
