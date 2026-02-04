"""
类型定义
"""

from typing import Optional, List, Dict, Any, Union
from enum import Enum
from pydantic import BaseModel, Field


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
    model_config = {"populate_by_name": True}

    id: str
    name: str
    type: AccountType
    token: str  # Bot Token 或 API Hash
    session_path: Optional[str] = Field(default=None, alias="sessionPath")  # Session文件路径 (仅client)
    session_string: Optional[str] = Field(default=None, alias="sessionString")  # Session字符串 (仅client, 加密存储)
    api_id: Optional[int] = Field(default=None, alias="apiId")  # API ID (仅client)
    api_hash: Optional[str] = Field(default=None, alias="apiHash")  # API Hash (仅client)
    phone_number: Optional[str] = Field(default=None, alias="phoneNumber")
    two_factor_password: Optional[str] = Field(default=None, alias="twoFactorPassword")
    proxy_url: Optional[str] = Field(default=None, alias="proxyUrl")
    role: Optional[str] = None
    session_type: Optional[str] = Field(default=None, alias="sessionType")
    enabled: bool = True


class TelegramMapping(BaseModel):
    """Telegram映射配置"""
    model_config = {"populate_by_name": True}

    id: str
    source_channel_id: str = Field(alias="sourceChannelId")
    target_channel_id: str = Field(alias="targetChannelId")
    type: str  # 'telegram-to-discord' | 'discord-to-telegram' | 'telegram-to-telegram'
    note: Optional[str] = None
    translate: bool = False
    translate_direction: str = Field(default="auto", alias="translateDirection")
    sender_account_type: Optional[str] = Field(default=None, alias="senderAccountType")
    sender_account_id: Optional[str] = Field(default=None, alias="senderAccountId")
    # Discord 账号的 showSourceIdentity 设置
    show_source_identity: bool = Field(default=True, alias="showSourceIdentity")
    # Telegram特有的超长消息处理
    longMessage: Optional[Dict[str, Any]] = None
    watermark: Optional[Any] = None
    watermarks: Optional[Any] = None
    watermark_secondary: Optional[Any] = Field(default=None, alias="watermarkSecondary")


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
    from_username: Optional[str] = None
    from_display_name: Optional[str] = None
    from_avatar_file: Optional[str] = None
    text: Optional[str] = None
    date: int
    media: Optional[List[Dict[str, Any]]] = None
    reply_to_message_id: Optional[int] = None
    reply_to_message: Optional[Dict[str, Any]] = None


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
