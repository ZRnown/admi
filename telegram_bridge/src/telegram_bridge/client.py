"""
Telegram客户端管理器
管理Telegram用户客户端的连接和消息处理
"""

import asyncio
from typing import Dict, List, Optional, Any
from telethon import TelegramClient
from telethon.tl.types import User, Chat, Channel
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError
from loguru import logger
from .types import TelegramAccount, ConnectionStatus, ConnectionState, TelegramChannel, TelegramMessage
from .session import SessionManager
from .connection import ConnectionManager, ReconnectConfig
from .media_handler import MediaHandler


class TelegramClientManager:
    """Telegram客户端管理器"""

    def __init__(self, reconnect_config: Optional[ReconnectConfig] = None):
        self.clients: Dict[str, TelegramClient] = {}
        self.session_manager = SessionManager()
        self.message_handlers: Dict[str, callable] = {}
        self.connection_manager = ConnectionManager(reconnect_config or ReconnectConfig())
        self.media_handler = MediaHandler()
        self._setup_connection_callbacks()

    def _setup_connection_callbacks(self):
        """设置连接状态回调"""
        # 为所有可能的账号设置回调
        pass  # 动态注册在connect时处理

    async def connect(self, account: TelegramAccount) -> Dict[str, Any]:
        """连接Telegram客户端"""
        try:
            account_id = account.id

            # 如果已经连接，先断开
            if account_id in self.clients:
                await self.disconnect(account_id)

            # 注册状态回调
            self.connection_manager.register_status_callback(account_id, self._on_connection_state_changed)

            # 更新连接状态
            self.connection_manager.update_state(account_id, ConnectionStatus.CONNECTING)

            # 创建客户端
            if account.session_string:
                # 使用session字符串
                session_string = await self.session_manager.load_session_string(account_id)
                if not session_string:
                    session_string = account.session_string
                    await self.session_manager.save_session_string(account_id, session_string)

                client = TelegramClient(
                    session_string,
                    account.api_id,
                    account.api_hash,
                    proxy=account.proxy_url
                )
            else:
                # 使用session文件
                session_path = account.session_path or str(self.session_manager.get_session_path(account_id))
                client = TelegramClient(
                    session_path,
                    account.api_id,
                    account.api_hash,
                    proxy=account.proxy_url
                )

            # 启动客户端
            await client.start()

            # 获取用户信息
            me = await client.get_me()
            user_info = {
                "id": me.id,
                "firstName": me.first_name,
                "lastName": me.last_name,
                "username": me.username
            }

            # 保存客户端
            self.clients[account_id] = client

            # 更新连接状态
            import time
            self.connection_states[account_id] = ConnectionState(
                account_id=account_id,
                status=ConnectionStatus.CONNECTED,
                last_connected_at=int(time.time()),
                user_info=user_info
            )

            # 设置消息处理器
            client.add_event_handler(self._handle_message, account_id)

            # 更新连接状态
            self.connection_manager.update_state(
                account_id,
                ConnectionStatus.CONNECTED,
                user_info=user_info
            )

            logger.info(f"Telegram client connected for account {account_id}")
            return {
                "success": True,
                "userInfo": user_info
            }

        except SessionPasswordNeededError:
            logger.warning(f"2FA required for account {account.id}")
            self.connection_manager.update_state(
                account.id,
                ConnectionStatus.ERROR,
                "Two-factor authentication required"
            )
            return {
                "success": False,
                "error": "2FA_REQUIRED",
                "message": "Two-factor authentication required"
            }

        except PhoneCodeInvalidError:
            logger.warning(f"Phone code required for account {account.id}")
            self.connection_manager.update_state(
                account.id,
                ConnectionStatus.ERROR,
                "Phone code required"
            )
            return {
                "success": False,
                "error": "PHONE_CODE_REQUIRED",
                "message": "Phone code required for login"
            }

        except Exception as e:
            logger.error(f"Failed to connect Telegram client for account {account.id}: {e}")
            self.connection_manager.update_state(
                account.id,
                ConnectionStatus.ERROR,
                str(e)
            )
            return {
                "success": False,
                "error": "CONNECTION_FAILED",
                "message": str(e)
            }

    async def disconnect(self, account_id: str) -> Dict[str, Any]:
        """断开Telegram客户端连接"""
        try:
            # 停止重连
            await self.connection_manager.stop_reconnect(account_id)

            if account_id in self.clients:
                client = self.clients[account_id]
                await client.disconnect()
                del self.clients[account_id]

            # 更新连接状态
            self.connection_manager.update_state(account_id, ConnectionStatus.DISCONNECTED)

            logger.info(f"Telegram client disconnected for account {account_id}")
            return {"success": True}

        except Exception as e:
            logger.error(f"Failed to disconnect Telegram client for account {account_id}: {e}")
            return {
                "success": False,
                "error": "DISCONNECT_FAILED",
                "message": str(e)
            }

    async def disconnect_all(self):
        """断开所有客户端连接"""
        for account_id in list(self.clients.keys()):
            await self.disconnect(account_id)

    def get_status(self, account_id: str) -> Optional[ConnectionState]:
        """获取连接状态"""
        return self.connection_manager.get_state(account_id)

    def _on_connection_state_changed(self, account_id: str, state: ConnectionState):
        """连接状态变更回调"""
        logger.info(f"Connection state changed for {account_id}: {state.status}")

        # 如果连接断开，启动自动重连
        if state.status in [ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR]:
            if account_id in self.clients:  # 只为已配置的账号重连
                logger.info(f"Starting auto-reconnect for {account_id}")

                async def reconnect_func():
                    # 重新连接逻辑
                    # 这里需要访问账号配置，暂时简化处理
                    return {"success": False, "message": "Reconnect not implemented"}

                asyncio.create_task(
                    self.connection_manager.start_reconnect(account_id, reconnect_func)
                )

    async def _send_media_attachment(
        self,
        client: TelegramClient,
        chat_id: int,
        attachment: Dict[str, Any],
        caption: Optional[str] = None
    ) -> Dict[str, Any]:
        """发送媒体附件"""
        try:
            # 处理Discord附件
            media_result = await self.media_handler.process_discord_attachment(attachment)
            if not media_result:
                return {
                    "success": False,
                    "error": "MEDIA_PROCESS_FAILED",
                    "message": "Failed to process media attachment"
                }

            file_path, media_type = media_result

            # 上传到Telegram
            return await self.media_handler.upload_to_telegram(
                client, chat_id, file_path, media_type, caption or ""
            )

        except Exception as e:
            logger.error(f"Failed to send media attachment: {e}")
            return {
                "success": False,
                "error": "SEND_MEDIA_FAILED",
                "message": str(e)
            }

    async def get_channels(self, account_id: str) -> Dict[str, Any]:
        """获取频道列表"""
        try:
            if account_id not in self.clients:
                return {
                    "success": False,
                    "error": "NOT_CONNECTED",
                    "message": "Client not connected"
                }

            client = self.clients[account_id]
            dialogs = await client.get_dialogs()

            channels = []
            for dialog in dialogs:
                entity = dialog.entity

                if isinstance(entity, Channel):
                    channel_type = "channel"
                    if entity.megagroup:
                        channel_type = "supergroup"
                    elif entity.gigagroup:
                        channel_type = "group"
                elif isinstance(entity, Chat):
                    channel_type = "group"
                else:
                    continue  # 跳过私聊

                channel = TelegramChannel(
                    id=str(entity.id),
                    title=entity.title or "Unknown",
                    type=channel_type,
                    username=getattr(entity, 'username', None),
                    member_count=getattr(entity, 'participants_count', None)
                )
                channels.append(channel.dict())

            return {
                "success": True,
                "channels": channels
            }

        except Exception as e:
            logger.error(f"Failed to get channels for account {account_id}: {e}")
            return {
                "success": False,
                "error": "GET_CHANNELS_FAILED",
                "message": str(e)
            }

    async def send_message(self, account_id: str, chat_id: int, message: str, attachments: Optional[List[Dict[str, Any]]] = None, parse_mode: Optional[str] = None) -> Dict[str, Any]:
        """发送消息"""
        try:
            if account_id not in self.clients:
                return {
                    "success": False,
                    "error": "NOT_CONNECTED",
                    "message": "Client not connected"
                }

            client = self.clients[account_id]

            # 处理附件
            if attachments:
                for attachment in attachments:
                    result = await self._send_media_attachment(
                        client, chat_id, attachment, message if not message else None
                    )
                    if result["success"]:
                        return result  # 只发送第一个附件
                    else:
                        logger.error(f"Failed to send media attachment: {result['error']}")

            # 发送文本消息
            kwargs = {}
            if parse_mode:
                kwargs["parse_mode"] = parse_mode

            result = await client.send_message(chat_id, message, **kwargs)

            return {
                "success": True,
                "messageId": result.id
            }

        except Exception as e:
            logger.error(f"Failed to send message for account {account_id}: {e}")
            return {
                "success": False,
                "error": "SEND_MESSAGE_FAILED",
                "message": str(e)
            }

    async def _handle_message(self, event, account_id: str):
        """处理接收到的消息"""
        try:
            message = event.message

            # 跳过自己发送的消息（如果配置了）
            if message.from_id == message.chat_id:  # 群组消息
                # 检查是否是自己发送的（需要获取用户信息）
                pass

            # 解析媒体信息
            media = []
            if message.media:
                media_info = self._parse_media(message.media)
                if media_info:
                    media.append(media_info)

            # 转换为内部格式
            telegram_message = TelegramMessage(
                id=message.id,
                chat_id=message.chat_id,
                chat_title=getattr(message.chat, 'title', None),
                chat_username=getattr(message.chat, 'username', None),
                from_user=self._parse_user(message.from_user) if message.from_user else None,
                text=message.text,
                date=int(message.date.timestamp()),
                media=media,
                reply_to_message_id=message.reply_to_msg_id
            )

            # 调用消息处理器
            if account_id in self.message_handlers:
                await self.message_handlers[account_id](telegram_message.dict())
            else:
                logger.debug(f"No message handler for account {account_id}")

            # 发送消息到IPC进行转发处理
            # 这里需要访问主进程的IPC服务器，通过回调或其他方式
            # 暂时记录日志，实际实现需要架构调整

        except Exception as e:
            logger.error(f"Failed to handle message for account {account_id}: {e}")

    def _parse_user(self, user) -> Optional[Dict[str, Any]]:
        """解析用户信息"""
        if not user:
            return None

        return {
            "id": user.id,
            "firstName": getattr(user, 'first_name', None),
            "lastName": getattr(user, 'last_name', None),
            "username": getattr(user, 'username', None)
        }

    def _parse_media(self, media) -> Optional[Dict[str, Any]]:
        """解析媒体信息"""
        try:
            if hasattr(media, 'photo'):
                return {
                    "type": "photo",
                    "fileId": media.photo.id if hasattr(media.photo, 'id') else str(media.photo),
                    "fileName": None,
                    "mimeType": "image/jpeg",
                    "size": getattr(media.photo, 'size', None),
                    "caption": None
                }
            elif hasattr(media, 'document'):
                return {
                    "type": "document",
                    "fileId": media.document.id if hasattr(media.document, 'id') else str(media.document),
                    "fileName": getattr(media.document, 'file_name', None),
                    "mimeType": getattr(media.document, 'mime_type', None),
                    "size": getattr(media.document, 'size', None),
                    "caption": None
                }
            elif hasattr(media, 'video'):
                return {
                    "type": "video",
                    "fileId": media.video.id if hasattr(media.video, 'id') else str(media.video),
                    "fileName": None,
                    "mimeType": getattr(media.video, 'mime_type', None),
                    "size": getattr(media.video, 'size', None),
                    "caption": None
                }
            elif hasattr(media, 'audio'):
                return {
                    "type": "audio",
                    "fileId": media.audio.id if hasattr(media.audio, 'id') else str(media.audio),
                    "fileName": getattr(media.audio, 'file_name', None),
                    "mimeType": getattr(media.audio, 'mime_type', None),
                    "size": getattr(media.audio, 'size', None),
                    "caption": None
                }
        except Exception as e:
            logger.error(f"Failed to parse media: {e}")

        return None

    async def update_config(self, accounts: List[TelegramAccount]):
        """更新配置"""
        # 断开已删除的账号
        current_account_ids = {acc.id for acc in accounts}
        to_disconnect = set(self.clients.keys()) - current_account_ids

        for account_id in to_disconnect:
            await self.disconnect(account_id)

        # 连接新启用的账号
        for account in accounts:
            if account.type == "client" and account.enabled:
                if account.id not in self.clients:
                    await self.connect(account)
