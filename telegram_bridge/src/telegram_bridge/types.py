"""
类型定义
"""

from typing import Optional, List, Dict, Any, Union
from enum import Enum
from pydantic import BaseModel


class AccountType(str, Enum):
    """账号类型"""
    CLIENT = "client"  # 用户客户端
    BOT = "bot"       # 机器人


class ConnectionStatus(str, Enum):
    """连接状态"""
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    ERROR = "error"


class MessageType(str, Enum):
    """消息类型"""
    TEXT = "text"
    PHOTO = "photo"
    VIDEO = "video"
    AUDIO = "audio"
    DOCUMENT = "document"
    STICKER = "sticker"
    VOICE = "voice"


class TelegramAccount(BaseModel):
    """Telegram账号配置"""
    id: str
    name: str
    type: AccountType
    token: str  # Bot Token 或 API Hash
    session_path: Optional[str] = None  # Session文件路径 (仅client)
    session_string: Optional[str] = None  # Session字符串 (仅client, 加密存储)
    api_id: Optional[int] = None  # API ID (仅client)
    api_hash: Optional[str] = None  # API Hash (仅client)
    proxy_url: Optional[str] = None
    enabled: bool = True


class TelegramMapping(BaseModel):
    """Telegram映射配置"""
    id: str
    source_channel_id: str
    target_channel_id: str
    type: str  # 'telegram-to-discord' | 'discord-to-telegram'
    note: Optional[str] = None
    translate: bool = False
    translate_direction: str = "auto"  # 'off' | 'auto' | 'zh-en' | 'en-zh'
    # Telegram特有的超长消息处理
    longMessage: Optional[Dict[str, Any]] = None


class TelegramChannel(BaseModel):
    """Telegram频道信息"""
    id: str
    title: str
    type: str  # 'channel' | 'group' | 'supergroup' | 'private'
    username: Optional[str] = None
    member_count: Optional[int] = None


class TelegramMessage(BaseModel):
    """Telegram消息"""
    id: int
    chat_id: int
    chat_title: Optional[str] = None
    chat_username: Optional[str] = None
    from_user: Optional[Dict[str, Any]] = None
    text: Optional[str] = None
    date: int
    media: Optional[List[Dict[str, Any]]] = None
    reply_to_message_id: Optional[int] = None


class ConnectionState(BaseModel):
    """连接状态"""
    account_id: str
    status: ConnectionStatus
    last_connected_at: Optional[int] = None
    last_disconnected_at: Optional[int] = None
    reconnect_count: int = 0
    error_message: Optional[str] = None
    user_info: Optional[Dict[str, Any]] = None


class IPCMessage(BaseModel):
    """IPC消息"""
    id: str
    type: str  # 'request' | 'response' | 'notification'
    method: str
    params: Optional[Dict[str, Any]] = None
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None


class IPCRequest(BaseModel):
    """IPC请求"""
    id: str
    method: str
    params: Dict[str, Any]


class IPCResponse(BaseModel):
    """IPC响应"""
    id: str
    result: Optional[Any] = None
    error: Optional[Dict[str, Any]] = None


class IPCNotification(BaseModel):
    """IPC通知"""
    method: str
    params: Dict[str, Any]
