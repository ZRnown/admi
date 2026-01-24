"""
Telegram机器人管理器
管理Telegram机器人的连接和消息处理
"""

import asyncio
import os
import time
import aiohttp
from pathlib import Path
from typing import Dict, List, Optional, Any
from telethon import TelegramClient, events
from telethon.tl.types import User, Chat, Channel
from loguru import logger
from .telegram_types import TelegramAccount, ConnectionStatus, ConnectionState, TelegramChannel, TelegramMessage
from .connection import ConnectionManager, ReconnectConfig
from .media_handler import MediaHandler


class TelegramBotManager:
    """Telegram机器人管理器"""

    def __init__(self, reconnect_config: Optional[ReconnectConfig] = None):
        self.bots: Dict[str, TelegramClient] = {}
        self.bot_tokens: Dict[str, str] = {}  # 保存 bot token 用于 Bot API 调用
        self.message_handlers: Dict[str, callable] = {}
        self.connection_manager = ConnectionManager(reconnect_config or ReconnectConfig())
        self.media_handler = MediaHandler()
        self._connect_locks: Dict[str, asyncio.Lock] = {}
        self._update_tasks: Dict[str, asyncio.Task] = {}
        self._keepalive_tasks: Dict[str, asyncio.Task] = {}
        self._entity_cache: Dict[str, Dict[int, float]] = {}
        self._account_configs: Dict[str, TelegramAccount] = {}  # 保存账号配置用于重连
        base_dir = Path(__file__).resolve().parents[3]
        avatar_root = os.getenv("TELEGRAM_AVATAR_DIR") or str(base_dir / ".data" / "telegram_avatars")
        self.avatar_dir = Path(avatar_root)
        self.avatar_dir.mkdir(parents=True, exist_ok=True)
        self.avatar_cache: Dict[int, float] = {}
        self.avatar_ttl_seconds = 6 * 60 * 60
        self._entity_cache_seconds = 60 * 60
        self._watched_chats: Dict[str, set] = {}
        self._setup_connection_callbacks()

    def _setup_connection_callbacks(self):
        """设置连接状态回调"""
        pass  # 动态注册在connect时处理

    def update_watched_chats(self, account_id: str, chat_ids: list):
        """更新监听的频道列表"""
        normalized = set()
        for chat_id in chat_ids:
            if isinstance(chat_id, int):
                normalized.add(chat_id)
            elif isinstance(chat_id, str):
                cleaned = chat_id.strip().lstrip("@")
                if cleaned:
                    try:
                        normalized.add(int(cleaned))
                    except ValueError:
                        normalized.add(cleaned.lower())
        self._watched_chats[account_id] = normalized
        logger.info(f"Bot updated watched chats for {account_id}: {normalized}")

    def _is_watched_chat(self, account_id: str, chat_id: int, chat_username: str) -> bool:
        """检查是否是监听的频道"""
        watched = self._watched_chats.get(account_id)
        if not watched:
            return False
        if chat_id in watched:
            return True
        if chat_username:
            return chat_username.lstrip("@").lower() in watched
        return False

    def _get_connect_lock(self, account_id: str) -> asyncio.Lock:
        lock = self._connect_locks.get(account_id)
        if not lock:
            lock = asyncio.Lock()
            self._connect_locks[account_id] = lock
        return lock

    def _start_update_task(self, account_id: str, client: TelegramClient):
        if account_id in self._update_tasks:
            return
        self._update_tasks[account_id] = asyncio.create_task(self._run_update_loop(account_id, client))

    async def _stop_update_task(self, account_id: str):
        task = self._update_tasks.pop(account_id, None)
        if not task:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _run_update_loop(self, account_id: str, client: TelegramClient):
        try:
            await client.run_until_disconnected()
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Bot update loop crashed for account {account_id}: {e}")

    def _start_keepalive_task(self, account_id: str, client: TelegramClient):
        if account_id in self._keepalive_tasks:
            return
        self._keepalive_tasks[account_id] = asyncio.create_task(
            self._keepalive_loop(account_id, client)
        )

    async def _stop_keepalive_task(self, account_id: str):
        task = self._keepalive_tasks.pop(account_id, None)
        if not task:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _keepalive_loop(self, account_id: str, client: TelegramClient):
        while True:
            try:
                await asyncio.sleep(60)
                if not client.is_connected():
                    continue
                await client.get_dialogs(limit=1)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"Keepalive error for bot {account_id}: {e}")

    def _should_refresh_sender(self, account_id: str, sender: Any, sender_id: Optional[int]) -> bool:
        if not sender_id:
            return False
        cache = self._entity_cache.setdefault(account_id, {})
        last_refresh = cache.get(sender_id, 0)
        if time.time() - last_refresh < self._entity_cache_seconds:
            return False
        if sender is None:
            return True
        if getattr(sender, "min", False):
            return True
        if getattr(sender, "photo", None) is None:
            return True
        return False

    def _mark_sender_refreshed(self, account_id: str, sender_id: int):
        cache = self._entity_cache.setdefault(account_id, {})
        cache[sender_id] = time.time()

    async def connect(self, account: TelegramAccount | Dict[str, Any]) -> Dict[str, Any]:
        """连接Telegram机器人"""
        raw_account_id = None
        try:
            if isinstance(account, dict):
                raw_account_id = account.get("id")
                account = TelegramAccount(**account)
            account_id = account.id
            lock = self._get_connect_lock(account_id)
            if lock.locked():
                return {
                    "success": False,
                    "error": "CONNECT_IN_PROGRESS",
                    "message": "连接中，请稍后重试"
                }

            async with lock:
                # 如果 Bot 已存在且已连接，直接返回成功（修复：避免不必要的断开重连）
                if account_id in self.bots:
                    existing_bot = self.bots[account_id]
                    if existing_bot.is_connected():
                        try:
                            me = await existing_bot.get_me()
                            if me:
                                user_info = {
                                    "id": me.id,
                                    "firstName": me.first_name,
                                    "lastName": getattr(me, 'last_name', None),
                                    "username": me.username
                                }
                                # 更新状态
                                self.connection_manager.update_state(
                                    account_id,
                                    ConnectionStatus.CONNECTED,
                                    user_info=user_info
                                )
                                logger.info(f"Telegram bot already connected for account {account_id}")
                                return {
                                    "success": True,
                                    "user_info": user_info
                                }
                        except Exception as e:
                            logger.warning(f"Existing bot check failed, will reconnect: {e}")

                    # Bot 存在但未连接，断开后重连
                    await self.disconnect(account_id)
                    # 等待数据库锁释放
                    await asyncio.sleep(0.5)

                # 注册状态回调
                self.connection_manager.register_status_callback(account_id, self._on_connection_state_changed)

                # 更新连接状态
                self.connection_manager.update_state(account_id, ConnectionStatus.CONNECTING)

                # 默认的 API ID/Hash 列表（如果账号配置中没有提供）
                DEFAULT_API_CREDENTIALS = [
                    (20004517, "c607e8e343682f77bb83acc858cb46ee"),
                    (23980807, "0a763a3169fb12cdfdf902916c561d39"),
                    (22018615, "85858ff6922c54b00bc42cca1f0cf2db"),
                    (23732943, "ec4adb83497e3a1a5b9e8bddb9de493b"),
                    (20031336, "756771015239bf2dc80888ee90a74e2b"),
                    (25636369, "aa1044819f3c28950a6540356b23cb80"),
                    (20534748, "caf129bd562d37684d353b58a16ac38b"),
                    (24401651, "8066a37766bfa75b458b9b967b3850cb"),
                    (23689950, "893ce345e36cb2dcd6183aad3cc18a18"),
                    (21092580, "e70594067edf9bda863c8a29fb9952cc"),
                ]

                # 使用账号配置中的 API ID/Hash，如果没有则使用默认列表中的第一个
                use_api_id = account.api_id if account.api_id else DEFAULT_API_CREDENTIALS[0][0]
                use_api_hash = account.api_hash if account.api_hash else DEFAULT_API_CREDENTIALS[0][1]

                # 创建机器人客户端并启动，添加重试机制处理database locked
                max_retries = 5
                retry_delay = 1.0
                client = None

                for attempt in range(max_retries):
                    try:
                        client = TelegramClient(
                            f"bot_{account_id}",
                            api_id=use_api_id,
                            api_hash=use_api_hash,
                            proxy=account.proxy_url
                        )
                        await client.start(bot_token=account.token)
                        break
                    except Exception as e:
                        error_msg = str(e).lower()
                        if "database is locked" in error_msg or "locked" in error_msg:
                            logger.warning(f"Database locked on attempt {attempt + 1}/{max_retries}, retrying...")
                            if client:
                                try:
                                    await client.disconnect()
                                except:
                                    pass
                                client = None
                            await asyncio.sleep(retry_delay * (attempt + 1))
                            if attempt == max_retries - 1:
                                raise
                        else:
                            raise

                # 获取机器人信息
                me = await client.get_me()
                user_info = {
                    "id": me.id,
                    "firstName": me.first_name,
                    "lastName": me.last_name,
                    "username": me.username
                }

                # 保存机器人和账号配置（用于重连）
                self.bots[account_id] = client
                self.bot_tokens[account_id] = account.token  # 保存 token 用于 Bot API
                self._account_configs[account_id] = account

                # 更新连接状态
                self.connection_manager.update_state(
                    account_id,
                    ConnectionStatus.CONNECTED,
                    user_info=user_info
                )

                # 设置消息处理器 - 使用闭包捕获account_id
                async def message_handler(event):
                    asyncio.create_task(self._handle_message(event, account_id))

                client.add_event_handler(message_handler, events.NewMessage)
                self._start_update_task(account_id, client)
                self._start_keepalive_task(account_id, client)

                logger.info(f"Telegram bot connected for account {account_id}: @{me.username}")
                return {
                    "success": True,
                    "userInfo": user_info
                }

        except Exception as e:
            # 修复：安全获取 account_id，兼容对象和字典
            account_id = raw_account_id
            if not account_id and account:
                account_id = account.get("id") if isinstance(account, dict) else getattr(account, "id", None)

            logger.error(f"Failed to connect Telegram bot for account {account_id}: {e}")
            if account_id:
                self.connection_manager.update_state(
                    account_id,
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
            await self._stop_update_task(account_id)
            await self._stop_keepalive_task(account_id)

            # 清除旧配置，防止自动重连使用旧配置
            if account_id in self._account_configs:
                del self._account_configs[account_id]
            if account_id in self.bot_tokens:
                del self.bot_tokens[account_id]

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
            # 只为有保存配置的账号重连
            if account_id in self._account_configs:
                logger.info(f"Starting auto-reconnect for bot {account_id}")
                account_config = self._account_configs[account_id]

                async def reconnect_func():
                    # 使用保存的账号配置重新连接
                    return await self.connect(account_config)

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
        """发送消息 - 使用 Bot API 而不是 Telethon（避免实体缓存问题）"""
        try:
            if account_id not in self.bots:
                return {
                    "success": False,
                    "error": "NOT_CONNECTED",
                    "message": "Bot not connected"
                }

            # 获取 bot token
            token = self.bot_tokens.get(account_id)
            if not token:
                return {
                    "success": False,
                    "error": "TOKEN_NOT_FOUND",
                    "message": "Bot token not found"
                }

            # 使用 Bot API 发送消息
            return await self._send_message_via_bot_api(token, chat_id, message, parse_mode)

        except Exception as e:
            logger.error(f"Failed to send message for bot {account_id}: {e}")
            return {
                "success": False,
                "error": "SEND_MESSAGE_FAILED",
                "message": str(e)
            }

    async def _send_message_via_bot_api(self, token: str, chat_id: int, text: str, parse_mode: Optional[str] = None) -> Dict[str, Any]:
        """使用 Telegram Bot API 发送消息"""
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload) as resp:
                    data = await resp.json()
                    if data.get("ok"):
                        logger.info(f"Message sent via Bot API to chat_id {chat_id}")
                        return {
                            "success": True,
                            "messageId": data["result"]["message_id"]
                        }
                    else:
                        error_msg = data.get("description", "Unknown error")
                        logger.error(f"Bot API error: {error_msg}")
                        return {
                            "success": False,
                            "error": "BOT_API_ERROR",
                            "message": error_msg
                        }
        except Exception as e:
            logger.error(f"Failed to send message via Bot API: {e}")
            return {
                "success": False,
                "error": "BOT_API_REQUEST_FAILED",
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

            # 获取chat信息用于过滤
            chat_id = message.chat_id
            chat_username = getattr(message.chat, 'username', None)

            # 只处理配置中监听的频道，忽略其他频道的消息
            if not self._is_watched_chat(account_id, chat_id, chat_username):
                return

            # 解析媒体信息
            media = []
            if message.media:
                media_info = self._parse_media(message.media)
                if media_info:
                    media.append(media_info)

            # 获取发送者信息（兼容不同 Telethon 版本字段）
            sender = getattr(message, "sender", None)
            if sender is None:
                try:
                    sender = await message.get_sender()
                except Exception:
                    sender = None
            sender_id = (
                getattr(message, "sender_id", None)
                or getattr(sender, "id", None)
                or getattr(event, "sender_id", None)
            )
            if self._should_refresh_sender(account_id, sender, sender_id):
                try:
                    sender = await event.client.get_entity(sender_id)
                except Exception as e:
                    logger.debug(f"Failed to refresh sender entity: {e}")
                finally:
                    if sender_id:
                        self._mark_sender_refreshed(account_id, sender_id)
            from_user = self._parse_user(sender) if sender else None
            avatar_file = await self._get_avatar_file(event.client, sender) if sender else None
            if from_user and avatar_file:
                from_user["avatarFile"] = avatar_file

            reply_to_message = None
            if message.reply_to_msg_id:
                try:
                    reply_msg = await message.get_reply_message()
                    if reply_msg:
                        reply_sender = getattr(reply_msg, "sender", None)
                        if reply_sender is None:
                            try:
                                reply_sender = await reply_msg.get_sender()
                            except Exception:
                                reply_sender = None
                        reply_user = self._parse_user(reply_sender) if reply_sender else None
                        reply_avatar_file = await self._get_avatar_file(event.client, reply_sender) if reply_sender else None
                        if reply_user and reply_avatar_file:
                            reply_user["avatarFile"] = reply_avatar_file
                        reply_to_message = {
                            "id": reply_msg.id,
                            "text": reply_msg.message or reply_msg.text,
                            "from_user": reply_user
                        }
                except Exception as e:
                    logger.debug(f"Failed to load reply message: {e}")

            # 转换为内部格式
            telegram_message = TelegramMessage(
                id=message.id,
                chat_id=message.chat_id,
                chat_title=getattr(message.chat, 'title', None),
                chat_username=getattr(message.chat, 'username', None),
                from_user=from_user,
                from_username=from_user.get("username") if from_user else None,
                from_display_name=self._build_display_name(from_user),
                from_avatar_file=from_user.get("avatarFile") if from_user else None,
                text=message.text,
                date=int(message.date.timestamp()),
                media=media,
                reply_to_message_id=message.reply_to_msg_id,
                reply_to_message=reply_to_message
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

    def _build_display_name(self, user_info: Optional[Dict[str, Any]]) -> Optional[str]:
        if not user_info:
            return None
        name = f"{user_info.get('firstName') or ''} {user_info.get('lastName') or ''}".strip()
        return name or user_info.get("username")

    async def _get_avatar_file(self, client: TelegramClient, user: Any) -> Optional[str]:
        """下载并缓存用户头像，返回文件名"""
        filename = None
        try:
            user_id = getattr(user, "id", None)
            if not user_id:
                return None
            filename = f"{user_id}.jpg"
            file_path = self.avatar_dir / filename
            now = time.time()
            last_fetch = self.avatar_cache.get(user_id, 0)
            if file_path.exists() and (now - last_fetch) < self.avatar_ttl_seconds:
                return filename

            result = await client.download_profile_photo(user, file=str(file_path))
            if result:
                self.avatar_cache[user_id] = now
                return filename
        except Exception as e:
            logger.debug(f"Failed to download avatar: {e}")

        if filename and (self.avatar_dir / filename).exists():
            return filename
        return None

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

    async def update_config(self, accounts: List[TelegramAccount | Dict[str, Any]]):
        """更新配置"""
        from .telegram_types import TelegramAccount as TelegramAccountModel
        normalized = [
            TelegramAccountModel(**acc) if isinstance(acc, dict) else acc
            for acc in accounts
        ]

        # 1. 获取当前所有已连接的 ID
        current_account_ids = set(self.bots.keys())
        # 创建新配置的映射 map
        new_account_map = {acc.id: acc for acc in normalized}

        # 断开逻辑：不仅断开被删除的，也要断开 enabled=False 的
        for account_id in current_account_ids:
            # 如果账号不存在于新配置中，或者新配置中 enabled 为 False
            if account_id not in new_account_map or not new_account_map[account_id].enabled:
                logger.info(f"Disconnecting bot {account_id} (removed or disabled)")
                await self.disconnect(account_id)

        # 2. 连接新启用的机器人账号，或者 token 变化时重新连接
        for account in normalized:
            if account.type == "bot" and account.enabled:
                if account.id not in self.bots:
                    await self.connect(account)
                else:
                    # 检查 token 是否变化，如果变化则重新连接
                    old_token = self.bot_tokens.get(account.id)
                    if old_token and old_token != account.token:
                        logger.info(f"Token changed for bot {account.id}, reconnecting...")
                        await self.disconnect(account.id)
                        await self.connect(account)
