"""
Telegram客户端管理器
管理Telegram用户客户端的连接和消息处理
"""

import asyncio
import os
import time
from pathlib import Path
from typing import Dict, List, Optional, Any, Union
from telethon import TelegramClient, events
from telethon.tl.types import User, Chat, Channel
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError
from loguru import logger
from .telegram_types import TelegramAccount, ConnectionStatus, ConnectionState, TelegramChannel, TelegramMessage
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
        self._connect_locks: Dict[str, asyncio.Lock] = {}
        self._update_tasks: Dict[str, asyncio.Task] = {}
        self._keepalive_tasks: Dict[str, asyncio.Task] = {}
        self._entity_cache: Dict[str, Dict[int, float]] = {}
        self._account_configs: Dict[str, TelegramAccount] = {}  # 保存账号配置用于重连
        base_dir = Path(__file__).resolve().parents[3]
        avatar_root = os.getenv("TELEGRAM_AVATAR_DIR") or str(base_dir / ".data" / "telegram_avatars")
        media_root = os.getenv("TELEGRAM_MEDIA_DIR") or str(base_dir / ".data" / "telegram_media")
        self.avatar_dir = Path(avatar_root)
        self.avatar_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir = Path(media_root)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.avatar_cache: Dict[int, float] = {}
        self.avatar_ttl_seconds = 6 * 60 * 60
        self._entity_cache_seconds = 60 * 60
        self._setup_connection_callbacks()

    def _setup_connection_callbacks(self):
        """设置连接状态回调"""
        # 为所有可能的账号设置回调
        pass  # 动态注册在connect时处理

    def _get_connect_lock(self, account_id: str) -> asyncio.Lock:
        lock = self._connect_locks.get(account_id)
        if not lock:
            lock = asyncio.Lock()
            self._connect_locks[account_id] = lock
        return lock

    async def _disconnect_client(self, account_id: str) -> Dict[str, Any]:
        """断开Telegram客户端连接（内部方法，不处理锁）"""
        try:
            # 先取消注册状态回调，避免断开时触发自动重连导致闪烁
            self.connection_manager.unregister_status_callback(account_id)

            # 停止重连
            await self.connection_manager.stop_reconnect(account_id)
            await self._stop_update_task(account_id)
            await self._stop_keepalive_task(account_id)

            # 清除所有缓存
            if account_id in self._account_configs:
                del self._account_configs[account_id]
            if account_id in self._watched_chats:
                del self._watched_chats[account_id]
            if account_id in self._entity_cache:
                del self._entity_cache[account_id]

            if account_id in self.clients:
                client = self.clients[account_id]
                try:
                    await client.disconnect()
                except Exception:
                    pass  # 忽略断开时的错误
                del self.clients[account_id]

            # 更新连接状态（不会触发回调，因为已取消注册）
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
            logger.error(f"Update loop crashed for account {account_id}: {e}")

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
        """
        心跳保活循环：只对配置的频道执行 GetHistory 操作，避免休眠。
        """
        await asyncio.sleep(10)

        while True:
            try:
                if not client.is_connected():
                    await asyncio.sleep(30)
                    continue

                watched_chat_ids = self._get_watched_chat_ids(account_id)
                if not watched_chat_ids:
                    await asyncio.sleep(60)
                    continue

                logger.debug(f"Keepalive: {account_id} watching {len(watched_chat_ids)} chats")

                for chat_id in watched_chat_ids:
                    try:
                        await client.get_messages(chat_id, limit=1)
                        await asyncio.sleep(2)
                    except Exception as e:
                        logger.debug(f"Keepalive failed for chat {chat_id}: {e}")

                await asyncio.sleep(60)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.debug(f"Keepalive loop error for {account_id}: {e}")
                await asyncio.sleep(60)

    def _normalize_watched_chat_id(self, chat_id: Any) -> Optional[Union[int, str]]:
        if chat_id is None:
            return None
        if isinstance(chat_id, int):
            return chat_id
        if isinstance(chat_id, str):
            cleaned = chat_id.strip()
            if not cleaned:
                return None
            if cleaned.startswith("@"):
                cleaned = cleaned[1:]
            try:
                return int(cleaned)
            except ValueError:
                return cleaned.lower()
        return None

    def _get_watched_chat_ids(self, account_id: str) -> List[Union[int, str]]:
        watched_ids: List[Union[int, str]] = []
        try:
            if hasattr(self, "_watched_chats") and account_id in self._watched_chats:
                watched_ids = list(self._watched_chats[account_id])
        except Exception as e:
            logger.debug(f"Failed to get watched chat IDs for {account_id}: {e}")
        return watched_ids

    def update_watched_chats(self, account_id: str, chat_ids: List[Union[int, str]]):
        normalized: List[Union[int, str]] = []
        for chat_id in chat_ids:
            cleaned = self._normalize_watched_chat_id(chat_id)
            if cleaned is not None:
                normalized.append(cleaned)
        if not hasattr(self, "_watched_chats"):
            self._watched_chats = {}
        self._watched_chats[account_id] = set(normalized)
        logger.info(f"客户端账号 {account_id} 监听 {len(normalized)} 个聊天")

    def _is_watched_chat(
        self,
        account_id: str,
        chat_id: Optional[int],
        chat_username: Optional[str],
    ) -> bool:
        if not hasattr(self, "_watched_chats"):
            return False
        watched = self._watched_chats.get(account_id)
        if not watched:
            return False
        if chat_id in watched:
            return True
        if chat_username:
            name = chat_username.lstrip("@").lower()
            return name in watched
        return False

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
        """连接Telegram客户端"""
        raw_account_id = None
        client = None
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
                state = self.connection_manager.get_state(account_id)
                if state and state.status == ConnectionStatus.CONNECTED:
                    return {
                        "success": True,
                        "userInfo": state.user_info
                    }

                # 如果客户端已存在且已连接，直接返回成功（修复：避免不必要的断开重连）
                if account_id in self.clients:
                    existing_client = self.clients[account_id]
                    if existing_client.is_connected():
                        try:
                            me = await existing_client.get_me()
                            if me:
                                user_info = {
                                    "id": me.id,
                                    "firstName": me.first_name,
                                    "lastName": me.last_name,
                                    "username": me.username
                                }
                                # 更新状态
                                self.connection_manager.update_state(
                                    account_id,
                                    ConnectionStatus.CONNECTED,
                                    user_info=user_info
                                )
                                logger.info(f"Telegram client already connected for account {account_id}")
                                return {
                                    "success": True,
                                    "userInfo": user_info
                                }
                        except Exception as e:
                            logger.warning(f"Existing client check failed, will reconnect: {e}")

                    # 客户端存在但未连接，断开后重连
                    await self._disconnect_client(account_id)
                    # 等待数据库锁释放
                    await asyncio.sleep(0.5)

                # 注册状态回调
                self.connection_manager.register_status_callback(account_id, self._on_connection_state_changed)

                # 更新连接状态
                self.connection_manager.update_state(account_id, ConnectionStatus.CONNECTING)

                # 创建客户端并连接，添加重试机制处理database locked
                max_retries = 5
                retry_delay = 1.0
                client = None

                for attempt in range(max_retries):
                    try:
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

                        # 连接客户端
                        await client.connect()
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

                if not await client.is_user_authorized():
                    await client.disconnect()
                    self.connection_manager.update_state(
                        account_id,
                        ConnectionStatus.ERROR,
                        "Session未登录或已失效，请重新生成Session"
                    )
                    return {
                        "success": False,
                        "error": "SESSION_NOT_AUTHORIZED",
                        "message": "Session未登录或已失效，请重新生成Session"
                    }

                # 获取用户信息
                me = await client.get_me()
                user_info = {
                    "id": me.id,
                    "firstName": me.first_name,
                    "lastName": me.last_name,
                    "username": me.username
                }

                # 保存客户端和账号配置（用于重连）
                self.clients[account_id] = client
                self._account_configs[account_id] = account

                # 设置消息处理器
                async def message_handler(event):
                    asyncio.create_task(self._handle_message(event, account_id))

                client.add_event_handler(message_handler, events.NewMessage)
                self._start_update_task(account_id, client)
                self._start_keepalive_task(account_id, client)

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
            account_id = raw_account_id or (getattr(account, "id", None) if account is not None else None)
            logger.warning(f"2FA required for account {account_id}")
            if account_id:
                self.connection_manager.update_state(
                    account_id,
                    ConnectionStatus.ERROR,
                    "Two-factor authentication required"
                )
            return {
                "success": False,
                "error": "2FA_REQUIRED",
                "message": "Two-factor authentication required"
            }

        except PhoneCodeInvalidError:
            account_id = raw_account_id or (getattr(account, "id", None) if account is not None else None)
            logger.warning(f"Phone code required for account {account_id}")
            if account_id:
                self.connection_manager.update_state(
                    account_id,
                    ConnectionStatus.ERROR,
                    "Phone code required"
                )
            return {
                "success": False,
                "error": "PHONE_CODE_REQUIRED",
                "message": "Phone code required for login"
            }

        except Exception as e:
            # 修复：安全获取 account_id，兼容对象和字典
            account_id = raw_account_id
            if not account_id and account:
                account_id = account.get("id") if isinstance(account, dict) else getattr(account, "id", None)
            if client:
                try:
                    await client.disconnect()
                except Exception:
                    pass

            logger.error(f"Failed to connect Telegram client for account {account_id}: {e}")
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
        """断开Telegram客户端连接"""
        lock = self._get_connect_lock(account_id)
        async with lock:
            return await self._disconnect_client(account_id)

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
            # 只为有保存配置的账号重连
            if account_id in self._account_configs:
                logger.info(f"Starting auto-reconnect for {account_id}")
                account_config = self._account_configs[account_id]

                async def reconnect_func():
                    # 使用保存的账号配置重新连接
                    return await self.connect(account_config)

                asyncio.create_task(
                    self.connection_manager.start_reconnect(account_id, reconnect_func)
                )

    async def _send_media_attachment(
        self,
        client: TelegramClient,
        chat_id: int,
        attachment: Dict[str, Any],
        caption: Optional[str] = None,
        reply_to_message_id: Optional[int] = None,
        watermark: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """发送媒体附件"""
        try:
            # 处理Discord附件
            media_result = await self.media_handler.process_discord_attachment(attachment, watermark)
            if not media_result:
                return {
                    "success": False,
                    "error": "MEDIA_PROCESS_FAILED",
                    "message": "Failed to process media attachment"
                }

            file_path, media_type = media_result

            # 上传到Telegram
            return await self.media_handler.upload_to_telegram(
                client, chat_id, file_path, media_type, caption or "", reply_to_message_id
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

    async def send_message(
        self,
        account_id: str,
        chat_id: int,
        message: str,
        attachments: Optional[List[Dict[str, Any]]] = None,
        parse_mode: Optional[str] = None,
        reply_to_message_id: Optional[int] = None,
        watermark: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
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
                        client, chat_id, attachment, message if message else None, reply_to_message_id, watermark
                    )
                    if result["success"]:
                        return result  # 只发送第一个附件
                    else:
                        logger.error(f"Failed to send media attachment: {result['error']}")

            # 发送文本消息
            kwargs = {}
            if parse_mode:
                kwargs["parse_mode"] = parse_mode
            if reply_to_message_id:
                kwargs["reply_to"] = reply_to_message_id

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
            if not message:
                return

            # 跳过服务消息（入群/退群等）
            if getattr(message, "action", None):
                return

            # 获取chat信息用于过滤
            chat_id = message.chat_id
            chat_username = None
            try:
                chat = await event.get_chat()
                chat_username = getattr(chat, "username", None)
            except:
                pass

            # 只处理配置中监听的频道，忽略其他频道的消息
            if not self._is_watched_chat(account_id, chat_id, chat_username):
                return

            # 跳过自己发送的消息（如果配置了）
            if message.from_id == message.chat_id:  # 群组消息
                # 检查是否是自己发送的（需要获取用户信息）
                pass

            # 解析媒体信息
            media = []
            if message.media:
                media_info = self._parse_media(message.media)
                if media_info:
                    if media_info.get("type") == "photo":
                        local_path = await self._download_media_file(event, message)
                        if local_path:
                            media_info["localPath"] = local_path
                            media_info["fileName"] = Path(local_path).name
                    media.append(media_info)

            # 忽略空消息（没有文本也没有媒体）
            text_content = message.message or message.text or ""
            if not text_content and not media:
                return

            # 获取发送者信息（兼容不同 Telethon 版本字段）
            sender = None
            try:
                sender = await message.get_sender()
            except Exception:
                sender = getattr(message, "sender", None)
                if sender is None:
                    try:
                        sender = await event.get_sender()
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
            if from_user:
                from_user["displayName"] = self._build_display_name(from_user)
            avatar_file = await self._get_avatar_file(event.client, sender) if sender else None
            if from_user and avatar_file:
                from_user["avatarFile"] = avatar_file

            chat_title = None
            chat_username = None
            try:
                chat = await event.get_chat()
                chat_title = getattr(chat, "title", None) or getattr(chat, "username", None)
                chat_username = getattr(chat, "username", None)
            except Exception:
                chat_title = getattr(message.chat, "title", None)
                chat_username = getattr(message.chat, "username", None)

            if self._is_watched_chat(account_id, message.chat_id, chat_username):
                logger.debug(
                    f"收到 Telegram 更新: 账号={account_id} chat={message.chat_id} id={message.id}"
                )

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
                        if reply_user:
                            reply_user["displayName"] = self._build_display_name(reply_user)
                        reply_avatar_file = await self._get_avatar_file(event.client, reply_sender) if reply_sender else None
                        if reply_user and reply_avatar_file:
                            reply_user["avatarFile"] = reply_avatar_file
                        reply_to_message = {
                            "id": reply_msg.id,
                            "text": reply_msg.message or reply_msg.text or "",
                            "from_user": reply_user
                        }
                except Exception as e:
                    logger.debug(f"Failed to load reply message: {e}")

            # 转换为内部格式
            telegram_message = TelegramMessage(
                id=message.id,
                chat_id=message.chat_id,
                chat_title=chat_title,
                chat_username=chat_username,
                from_user=from_user,
                from_username=from_user.get("username") if from_user else None,
                from_display_name=self._build_display_name(from_user),
                from_avatar_file=from_user.get("avatarFile") if from_user else None,
                text=text_content,
                date=int(message.date.timestamp()),
                media=media,
                reply_to_message_id=message.reply_to_msg_id,
                reply_to_message=reply_to_message
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

    async def _download_media_file(self, event, message) -> Optional[str]:
        try:
            return await event.download_media(file=str(self.media_dir))
        except Exception as e:
            logger.debug(f"Failed to download media for message {getattr(message, 'id', None)}: {e}")
            return None

    async def update_config(self, accounts: List[TelegramAccount | Dict[str, Any]]):
        """更新配置"""
        from .telegram_types import TelegramAccount as TelegramAccountModel
        normalized = [
            TelegramAccountModel(**acc) if isinstance(acc, dict) else acc
            for acc in accounts
        ]

        # 1. 获取当前所有已连接的 ID
        current_account_ids = set(self.clients.keys())
        # 创建新配置的映射 map
        new_account_map = {acc.id: acc for acc in normalized}

        # 断开逻辑：不仅断开被删除的，也要断开 enabled=False 的
        for account_id in current_account_ids:
            # 如果账号不存在于新配置中，或者新配置中 enabled 为 False
            if account_id not in new_account_map or not new_account_map[account_id].enabled:
                logger.info(f"Disconnecting client {account_id} (removed or disabled)")
                await self.disconnect(account_id)

        # 2. 连接新启用的账号
        for account in normalized:
            if account.type == "client" and account.enabled:
                if account.id not in self.clients:
                    await self.connect(account)
