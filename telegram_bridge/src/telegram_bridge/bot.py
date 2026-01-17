"""
Telegram机器人管理器
管理Telegram机器人的连接和消息处理
"""

import asyncio
from typing import Dict, List, Optional, Any
from telethon import TelegramClient
from telethon.tl.types import User, Chat, Channel
from loguru import logger
from .types import TelegramAccount, ConnectionStatus, ConnectionState, TelegramChannel, TelegramMessage
from .connection import ConnectionManager, ReconnectConfig
from .media_handler import MediaHandler


class TelegramBotManager:
    """Telegram机器人管理器"""

    def __init__(self, reconnect_config: Optional[ReconnectConfig] = None):
        self.bots: Dict[str, TelegramClient] = {}
        self.message_handlers: Dict[str, callable] = {}
        self.connection_manager = ConnectionManager(reconnect_config or ReconnectConfig())
        self.media_handler = MediaHandler()
        self._setup_connection_callbacks()

    def _setup_connection_callbacks(self):
        """设置连接状态回调"""
        pass  # 动态注册在connect时处理

    async def connect(self, account: TelegramAccount) -> Dict[str, Any]:
        """连接Telegram机器人"""
        try:
            account_id = account.id

            # 如果已经连接，先断开
            if account_id in self.bots:
                await self.disconnect(account_id)

            # 注册状态回调
            self.connection_manager.register_status_callback(account_id, self._on_connection_state_changed)

            # 更新连接状态
            self.connection_manager.update_state(account_id, ConnectionStatus.CONNECTING)

            # 创建机器人客户端
            client = TelegramClient(
                f"bot_{account_id}",
                api_id=None,  # 机器人不需要API ID
                api_hash=None,  # 机器人不需要API Hash
                proxy=account.proxy_url
            )

            # 使用Bot Token启动
            await client.start(bot_token=account.token)

            # 获取机器人信息
            me = await client.get_me()
            user_info = {
                "id": me.id,
                "firstName": me.first_name,
                "lastName": me.last_name,
                "username": me.username
            }

            # 保存机器人
            self.bots[account_id] = client

            # 更新连接状态
            self.connection_manager.update_state(
                account_id,
                ConnectionStatus.CONNECTED,
                user_info=user_info
            )

            # 设置消息处理器
            client.add_event_handler(self._handle_message, account_id)

            logger.info(f"Telegram bot connected for account {account_id}")
            return {
                "success": True,
                "userInfo": user_info
            }

        except Exception as e:
            logger.error(f"Failed to connect Telegram bot for account {account.id}: {e}")
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
        """断开Telegram机器人连接"""
        try:
            # 停止重连
            await self.connection_manager.stop_reconnect(account_id)

            if account_id in self.bots:
                bot = self.bots[account_id]
                await bot.disconnect()
                del self.bots[account_id]

            # 更新连接状态
            self.connection_manager.update_state(account_id, ConnectionStatus.DISCONNECTED)

            logger.info(f"Telegram bot disconnected for account {account_id}")
            return {"success": True}

        except Exception as e:
            logger.error(f"Failed to disconnect Telegram bot for account {account_id}: {e}")
            return {
                "success": False,
                "error": "DISCONNECT_FAILED",
                "message": str(e)
            }

    async def disconnect_all(self):
        """断开所有机器人连接"""
        for account_id in list(self.bots.keys()):
            await self.disconnect(account_id)

    def get_status(self, account_id: str) -> Optional[ConnectionState]:
        """获取连接状态"""
        return self.connection_manager.get_state(account_id)

    def _on_connection_state_changed(self, account_id: str, state: ConnectionState):
        """连接状态变更回调"""
        logger.info(f"Bot connection state changed for {account_id}: {state.status}")

        # 如果连接断开，启动自动重连
        if state.status in [ConnectionStatus.DISCONNECTED, ConnectionStatus.ERROR]:
            if account_id in self.bots:  # 只为已配置的账号重连
                logger.info(f"Starting auto-reconnect for bot {account_id}")

                async def reconnect_func():
                    # 重新连接逻辑
                    return {"success": False, "message": "Reconnect not implemented"}

                asyncio.create_task(
                    self.connection_manager.start_reconnect(account_id, reconnect_func)
                )

    async def _send_media_attachment(
        self,
        bot: TelegramClient,
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
                bot, chat_id, file_path, media_type, caption or ""
            )

        except Exception as e:
            logger.error(f"Failed to send media attachment: {e}")
            return {
                "success": False,
                "error": "SEND_MEDIA_FAILED",
                "message": str(e)
            }

    async def get_channels(self, account_id: str) -> Dict[str, Any]:
        """获取机器人可访问的频道列表"""
        try:
            if account_id not in self.bots:
                return {
                    "success": False,
                    "error": "NOT_CONNECTED",
                    "message": "Bot not connected"
                }

            bot = self.bots[account_id]

            # 机器人只能访问已添加的频道
            # 这里简化处理，返回机器人所在的对话
            dialogs = await bot.get_dialogs()

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
            logger.error(f"Failed to get channels for bot {account_id}: {e}")
            return {
                "success": False,
                "error": "GET_CHANNELS_FAILED",
                "message": str(e)
            }

    async def send_message(self, account_id: str, chat_id: int, message: str, attachments: Optional[List[Dict[str, Any]]] = None, parse_mode: Optional[str] = None) -> Dict[str, Any]:
        """发送消息"""
        try:
            if account_id not in self.bots:
                return {
                    "success": False,
                    "error": "NOT_CONNECTED",
                    "message": "Bot not connected"
                }

            bot = self.bots[account_id]

            # 处理附件
            if attachments:
                for attachment in attachments:
                    result = await self._send_media_attachment(
                        bot, chat_id, attachment, message if not message else None
                    )
                    if result["success"]:
                        return result  # 只发送第一个附件
                    else:
                        logger.error(f"Failed to send media attachment: {result['error']}")

            # 发送文本消息
            kwargs = {}
            if parse_mode:
                kwargs["parse_mode"] = parse_mode

            result = await bot.send_message(chat_id, message, **kwargs)

            return {
                "success": True,
                "messageId": result.id
            }

        except Exception as e:
            logger.error(f"Failed to send message for bot {account_id}: {e}")
            return {
                "success": False,
                "error": "SEND_MESSAGE_FAILED",
                "message": str(e)
            }

    async def _handle_message(self, event, account_id: str):
        """处理接收到的消息"""
        try:
            message = event.message

            # 跳过机器人自己的消息（避免循环）
            me = None
            if account_id in self.bots:
                try:
                    me = await self.bots[account_id].get_me()
                except:
                    pass

            if me and message.from_id == me.id:
                return  # 跳过机器人自己的消息

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
                logger.debug(f"No message handler for bot {account_id}")

        except Exception as e:
            logger.error(f"Failed to handle message for bot {account_id}: {e}")

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
        current_account_ids = {acc.id for acc in accounts if acc.type == "bot"}
        to_disconnect = set(self.bots.keys()) - current_account_ids

        for account_id in to_disconnect:
            await self.disconnect(account_id)

        # 连接新启用的机器人账号
        for account in accounts:
            if account.type == "bot" and account.enabled:
                if account.id not in self.bots:
                    await self.connect(account)
