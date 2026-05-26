"""
Telegram机器人管理器
管理Telegram机器人的连接和消息处理
"""

import asyncio
import os
import time
import json
import aiohttp
from pathlib import Path
from typing import Dict, List, Optional, Any, Union
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
        self._http_session: Optional[aiohttp.ClientSession] = None
        self._connect_locks: Dict[str, asyncio.Lock] = {}
        self._update_tasks: Dict[str, asyncio.Task] = {}
        self._keepalive_tasks: Dict[str, asyncio.Task] = {}
        self._entity_cache: Dict[str, Dict[int, float]] = {}
        self._account_configs: Dict[str, TelegramAccount] = {}  # 保存账号配置用于重连
        self._shared_clients: Dict[str, TelegramClient] = {}
        self._shared_account_ids: Dict[str, set] = {}
        self._shared_by_account: Dict[str, str] = {}
        self._shared_primary: Dict[str, str] = {}
        self._shared_user_info: Dict[str, dict] = {}
        self._event_handlers: Dict[str, Any] = {}
        self._chat_action_handlers: Dict[str, Any] = {}
        base_dir = Path(__file__).resolve().parents[3]
        avatar_root = os.getenv("TELEGRAM_AVATAR_DIR") or str(base_dir / ".data" / "telegram_avatars")
        media_root = os.getenv("TELEGRAM_MEDIA_DIR") or str(base_dir / ".data" / "telegram_media")
        self.dialogs_cache_file = base_dir / ".data" / "telegram_dialogs_cache.json"
        self._dialogs_cache_seen: Dict[str, set] = {}
        self.avatar_dir = Path(avatar_root)
        self.avatar_dir.mkdir(parents=True, exist_ok=True)
        self.media_dir = Path(media_root)
        self.media_dir.mkdir(parents=True, exist_ok=True)
        self.avatar_cache: Dict[int, float] = {}
        self.avatar_ttl_seconds = 6 * 60 * 60
        self._entity_cache_seconds = 60 * 60
        self._watched_chats: Dict[str, set] = {}
        self._unwatched_log_count: Dict[str, int] = {}
        self._setup_connection_callbacks()

    def _get_http_session(self) -> aiohttp.ClientSession:
        if self._http_session and not self._http_session.closed:
            return self._http_session
        timeout = aiohttp.ClientTimeout(total=20, connect=6)
        connector = aiohttp.TCPConnector(limit=64, ttl_dns_cache=300, keepalive_timeout=30)
        self._http_session = aiohttp.ClientSession(timeout=timeout, connector=connector)
        return self._http_session

    async def close(self):
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
        self._http_session = None
        await self.media_handler.close()

    def _setup_connection_callbacks(self):
        """设置连接状态回调"""
        pass  # 动态注册在connect时处理

    def _format_account_label(self, account_id: str) -> str:
        user_info = None
        shared_key = self._shared_by_account.get(account_id)
        if shared_key:
            user_info = self._shared_user_info.get(shared_key)
        if not user_info:
            state = self.connection_manager.get_state(account_id)
            user_info = state.user_info if state else None
        if user_info:
            username = user_info.get("username")
            display = self._build_display_name(user_info)
            if username:
                return f"{account_id}(@{username})"
            if display:
                return f"{account_id}({display})"
        return account_id

    def _build_chat_id_candidates(self, chat_id: int) -> set:
        candidates = {chat_id}
        try:
            if isinstance(chat_id, int) and chat_id < 0:
                abs_id = abs(chat_id)
                candidates.add(abs_id)
                abs_str = str(abs_id)
                if abs_str.startswith("100") and len(abs_str) > 3:
                    try:
                        candidates.add(int(abs_str[3:]))
                    except Exception:
                        pass
        except Exception:
            pass
        return candidates

    def _build_dialog_entry(self, chat_id: int, chat_title: Optional[str], chat_username: Optional[str], chat_type: Optional[str]):
        chat_id_str = str(chat_id) if chat_id is not None else ""
        if not chat_id_str:
            return None
        title = (chat_title or "").strip()
        username = (chat_username or "").strip()
        if username.startswith("@"):
            username = username[1:]
        if not title and username:
            title = f"@{username}"
        if not title:
            title = chat_id_str
        entry_type = chat_type or ""
        if not entry_type:
            try:
                numeric = int(chat_id)
                if numeric < 0:
                    abs_str = str(abs(numeric))
                    entry_type = "supergroup" if abs_str.startswith("100") else "group"
                else:
                    entry_type = "private"
            except Exception:
                entry_type = "unknown"
        return {
            "id": chat_id_str,
            "title": title,
            "type": entry_type,
            "username": username or None,
            "member_count": None,
        }

    def _resolve_chat_type(self, chat: Any, fallback: Optional[str] = None) -> str:
        if fallback:
            return fallback
        raw_type = getattr(chat, "type", None)
        if isinstance(raw_type, str) and raw_type:
            return raw_type
        if isinstance(chat, Channel):
            if getattr(chat, "megagroup", False):
                return "supergroup"
            if getattr(chat, "gigagroup", False):
                return "group"
            return "channel"
        if isinstance(chat, Chat):
            return "group"
        if isinstance(chat, User):
            return "private"
        if getattr(chat, "megagroup", False):
            return "supergroup"
        if getattr(chat, "gigagroup", False):
            return "group"
        return "unknown"

    def _load_dialogs_cache(self) -> Dict[str, Any]:
        try:
            if self.dialogs_cache_file.exists():
                with open(self.dialogs_cache_file, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception:
            pass
        return {}

    def _ensure_dialogs_seen(self, account_id: str) -> set:
        seen = self._dialogs_cache_seen.get(account_id)
        if seen is not None:
            return seen
        cache = self._load_dialogs_cache()
        existing = cache.get(account_id) if isinstance(cache.get(account_id), list) else []
        seen = set()
        for item in existing:
            if isinstance(item, dict) and item.get("id") is not None:
                seen.add(str(item.get("id")))
        self._dialogs_cache_seen[account_id] = seen
        return seen

    def _record_dialog(self, account_id: str, chat_id: int, chat_title: Optional[str], chat_username: Optional[str], chat_type: Optional[str]):
        try:
            entry = self._build_dialog_entry(chat_id, chat_title, chat_username, chat_type)
            if not entry:
                return
            seen = self._ensure_dialogs_seen(account_id)
            if entry["id"] in seen:
                return
            cache = self._load_dialogs_cache()
            existing = cache.get(account_id) if isinstance(cache.get(account_id), list) else []
            merged_map = {}
            for item in existing:
                if isinstance(item, dict) and item.get("id") is not None:
                    merged_map[str(item.get("id"))] = item
            merged_map[entry["id"]] = entry
            cache[account_id] = list(merged_map.values())
            self.dialogs_cache_file.parent.mkdir(parents=True, exist_ok=True)
            with open(self.dialogs_cache_file, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False, indent=2)
            seen.add(entry["id"])
        except Exception:
            pass

    def _extract_bot_api_chat(self, update: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        for field in (
            "message",
            "channel_post",
            "edited_message",
            "edited_channel_post",
            "my_chat_member",
            "chat_member",
            "business_message",
            "edited_business_message",
        ):
            payload = update.get(field)
            if isinstance(payload, dict) and isinstance(payload.get("chat"), dict):
                return payload["chat"]
        return None

    def _ensure_event_handlers(self, account_id: str, client: TelegramClient):
        if account_id not in self._event_handlers:
            async def message_handler(event, acc_id=account_id):
                asyncio.create_task(self._handle_message(event, acc_id))

            client.add_event_handler(message_handler, events.NewMessage)
            self._event_handlers[account_id] = message_handler

        if account_id not in self._chat_action_handlers:
            async def chat_action_handler(event, acc_id=account_id):
                asyncio.create_task(self._handle_chat_action(event, acc_id))

            client.add_event_handler(chat_action_handler, events.ChatAction)
            self._chat_action_handlers[account_id] = chat_action_handler

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
        self._unwatched_log_count[account_id] = 0
        preview = list(normalized)[:8]
        suffix = "" if len(normalized) <= 8 else f"...(共{len(normalized)})"
        account_label = self._format_account_label(account_id)
        logger.info(f"机器人账号 {account_label} 监听 {len(normalized)} 个聊天: {preview}{suffix}")

    def _is_watched_chat(self, account_id: str, chat_id: int, chat_username: str) -> bool:
        """检查是否是监听的频道"""
        watched = self._watched_chats.get(account_id)
        if not watched:
            return False
        for candidate in self._build_chat_id_candidates(chat_id):
            if candidate in watched:
                return True
        if chat_username:
            return chat_username.lstrip("@").lower() in watched
        return False

    def _get_connect_lock(self, lock_id: str) -> asyncio.Lock:
        lock = self._connect_locks.get(lock_id)
        if not lock:
            lock = asyncio.Lock()
            self._connect_locks[lock_id] = lock
        return lock

    def _get_task_key(self, account_id: str) -> str:
        return self._shared_by_account.get(account_id) or account_id

    def _build_shared_key(self, account: TelegramAccount) -> Optional[str]:
        token = account.token or ""
        if not token:
            return None
        return f"bot:{token}"

    def _get_keepalive_chat_ids(self, task_key: str) -> List[Union[int, str]]:
        if task_key in self._shared_account_ids:
            combined: set = set()
            for acc_id in self._shared_account_ids.get(task_key, set()):
                combined.update(self._watched_chats.get(acc_id, set()))
            return list(combined)
        return list(self._watched_chats.get(task_key, set()))

    async def _attach_shared_bot(
        self,
        account_id: str,
        account: TelegramAccount,
        shared_key: str,
        client: TelegramClient,
    ) -> Dict[str, Any]:
        self.bots[account_id] = client
        self.bot_tokens[account_id] = account.token or ""
        self._account_configs[account_id] = account
        self._shared_by_account[account_id] = shared_key
        self._shared_account_ids.setdefault(shared_key, set()).add(account_id)

        self._ensure_event_handlers(account_id, client)

        if shared_key not in self._shared_primary:
            self._shared_primary[shared_key] = account_id
            self.connection_manager.register_status_callback(account_id, self._on_connection_state_changed)

        user_info = self._shared_user_info.get(shared_key)
        if not user_info:
            try:
                me = await client.get_me()
                if me:
                    user_info = {
                        "id": me.id,
                        "firstName": me.first_name,
                        "lastName": getattr(me, "last_name", None),
                        "username": me.username
                    }
                    self._shared_user_info[shared_key] = user_info
            except Exception as e:
                logger.debug(f"Failed to fetch shared bot user info: {e}")
        if user_info:
            self.connection_manager.update_state(
                account_id,
                ConnectionStatus.CONNECTED,
                user_info=user_info
            )
        else:
            self.connection_manager.update_state(account_id, ConnectionStatus.CONNECTED)
        return {
            "success": True,
            "userInfo": user_info
        }

    def _start_update_task(self, account_id: str, client: TelegramClient):
        task_key = self._get_task_key(account_id)
        if task_key in self._update_tasks:
            return
        self._update_tasks[task_key] = asyncio.create_task(self._run_update_loop(task_key, client))

    async def _stop_update_task(self, account_id: str):
        task_key = self._get_task_key(account_id)
        task = self._update_tasks.pop(task_key, None)
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
        task_key = self._get_task_key(account_id)
        if task_key in self._keepalive_tasks:
            return
        self._keepalive_tasks[task_key] = asyncio.create_task(
            self._keepalive_loop(task_key, client)
        )

    async def _stop_keepalive_task(self, account_id: str):
        task_key = self._get_task_key(account_id)
        task = self._keepalive_tasks.pop(task_key, None)
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

    async def connect(self, account: Union[TelegramAccount, Dict[str, Any]]) -> Dict[str, Any]:
        """连接Telegram机器人"""
        raw_account_id = None
        try:
            if isinstance(account, dict):
                raw_account_id = account.get("id")
                account = TelegramAccount(**account)
            account_id = account.id
            shared_key = self._build_shared_key(account)
            lock = self._get_connect_lock(shared_key or account_id)
            if lock.locked():
                return {
                    "success": False,
                    "error": "CONNECT_IN_PROGRESS",
                    "message": "连接中，请稍后重试"
                }

            async with lock:
                if shared_key:
                    shared_bot = self._shared_clients.get(shared_key)
                    if shared_bot and shared_bot.is_connected():
                        return await self._attach_shared_bot(account_id, account, shared_key, shared_bot)
                    if shared_bot:
                        try:
                            await shared_bot.disconnect()
                        except Exception:
                            pass
                        self._shared_clients.pop(shared_key, None)
                        self._shared_account_ids.pop(shared_key, None)
                        self._shared_primary.pop(shared_key, None)
                        self._shared_user_info.pop(shared_key, None)

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
                                    "userInfo": user_info
                                }
                        except Exception as e:
                            logger.warning(f"Existing bot check failed, will reconnect: {e}")

                    # Bot 存在但未连接，断开后重连
                    await self.disconnect(account_id)
                    # 等待数据库锁释放
                    await asyncio.sleep(0.5)

                # 注册状态回调
                if not shared_key or shared_key not in self._shared_primary:
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

                if shared_key:
                    self._shared_clients[shared_key] = client
                    self._shared_user_info[shared_key] = user_info
                    result = await self._attach_shared_bot(account_id, account, shared_key, client)
                else:
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

                    self._ensure_event_handlers(account_id, client)

                    result = {
                        "success": True,
                        "userInfo": user_info
                    }

                self._start_update_task(account_id, client)
                self._start_keepalive_task(account_id, client)

                logger.info(f"Telegram bot connected for account {account_id}: @{me.username}")
                return result

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
            lock_key = self._shared_by_account.get(account_id) or account_id
            lock = self._get_connect_lock(lock_key)
            async with lock:
                return await self._disconnect_inner(account_id)
        except Exception as e:
            logger.error(f"Failed to disconnect Telegram bot for account {account_id}: {e}")
            return {
                "success": False,
                "error": "DISCONNECT_FAILED",
                "message": str(e)
            }

    async def _disconnect_inner(self, account_id: str) -> Dict[str, Any]:
        """断开Telegram机器人连接（内部方法，不处理锁）"""
        try:
            shared_key = self._shared_by_account.get(account_id)
            bot = self.bots.get(account_id)

            # 先取消注册状态回调，避免断开时触发自动重连导致闪烁
            self.connection_manager.unregister_status_callback(account_id)

            # 停止重连
            await self.connection_manager.stop_reconnect(account_id)

            # 清除所有缓存，防止自动重连使用旧配置
            if account_id in self._account_configs:
                del self._account_configs[account_id]
            if account_id in self.bot_tokens:
                del self.bot_tokens[account_id]
            if account_id in self._watched_chats:
                del self._watched_chats[account_id]
            if account_id in self._entity_cache:
                del self._entity_cache[account_id]

            handler = self._event_handlers.pop(account_id, None)
            if handler and bot:
                try:
                    bot.remove_event_handler(handler, events.NewMessage)
                except Exception:
                    pass
            chat_action_handler = self._chat_action_handlers.pop(account_id, None)
            if chat_action_handler and bot:
                try:
                    bot.remove_event_handler(chat_action_handler, events.ChatAction)
                except Exception:
                    pass

            if account_id in self.bots:
                del self.bots[account_id]

            if shared_key:
                account_ids = self._shared_account_ids.get(shared_key, set())
                if account_id in account_ids:
                    account_ids.remove(account_id)
                if account_ids:
                    if self._shared_primary.get(shared_key) == account_id:
                        new_primary = next(iter(account_ids))
                        self._shared_primary[shared_key] = new_primary
                        self.connection_manager.register_status_callback(
                            new_primary, self._on_connection_state_changed
                        )
                    self._shared_by_account.pop(account_id, None)
                    self.connection_manager.update_state(account_id, ConnectionStatus.DISCONNECTED)
                    logger.info(f"Telegram bot detached for account {account_id} (shared)")
                    return {"success": True}

                self._shared_by_account.pop(account_id, None)
                self._shared_account_ids.pop(shared_key, None)
                self._shared_primary.pop(shared_key, None)
                self._shared_user_info.pop(shared_key, None)
                await self._stop_update_task(shared_key)
                await self._stop_keepalive_task(shared_key)
                shared_bot = self._shared_clients.pop(shared_key, None)
                if shared_bot:
                    try:
                        await shared_bot.disconnect()
                    except Exception:
                        pass

                # 更新连接状态（不会触发回调，因为已取消注册）
                self.connection_manager.update_state(account_id, ConnectionStatus.DISCONNECTED)

                logger.info(f"Telegram bot disconnected for account {account_id}")
                return {"success": True}

            await self._stop_update_task(account_id)
            await self._stop_keepalive_task(account_id)
            if bot:
                try:
                    await bot.disconnect()
                except Exception:
                    pass  # 忽略断开时的错误

            # 更新连接状态（不会触发回调，因为已取消注册）
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
        shared_key = self._shared_by_account.get(account_id)
        if shared_key:
            for acc_id in self._shared_account_ids.get(shared_key, set()):
                if acc_id == account_id:
                    continue
                self.connection_manager.update_state(
                    acc_id,
                    state.status,
                    state.error_message,
                    state.user_info,
                )
            if self._shared_primary.get(shared_key) != account_id:
                return

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
        caption: Optional[str] = None,
        reply_to_message_id: Optional[int] = None,
        watermark: Optional[Any] = None,
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
                bot, chat_id, file_path, media_type, caption or "", reply_to_message_id
            )

        except Exception as e:
            logger.error(f"Failed to send media attachment: {e}")
            return {
                "success": False,
                "error": "SEND_MEDIA_FAILED",
                "message": str(e)
            }

    async def get_channels(self, account_id: str) -> Dict[str, Any]:
        """获取机器人可访问的频道列表 - 优先使用 Telethon get_dialogs，回退到 Bot API"""
        try:
            if account_id not in self.bots:
                return {
                    "success": False,
                    "error": "NOT_CONNECTED",
                    "message": "Bot not connected"
                }

            token = self.bot_tokens.get(account_id)
            if not token:
                return {
                    "success": False,
                    "error": "TOKEN_NOT_FOUND",
                    "message": "Bot token not found"
                }

            channels = []
            seen_chat_ids = set()
            note_parts: List[str] = []

            # 方法1: 优先使用 Telethon 的 get_dialogs（更可靠）
            bot = self.bots.get(account_id)
            if bot and bot.is_connected():
                try:
                    dialogs = await bot.get_dialogs()
                    for dialog in dialogs:
                        entity = dialog.entity
                        chat_id = entity.id
                        if chat_id in seen_chat_ids:
                            continue
                        seen_chat_ids.add(chat_id)

                        # 确定类型
                        if isinstance(entity, Channel):
                            if entity.megagroup:
                                chat_type = "supergroup"
                            elif entity.gigagroup:
                                chat_type = "group"
                            else:
                                chat_type = "channel"
                        elif isinstance(entity, Chat):
                            chat_type = "group"
                        elif isinstance(entity, User):
                            chat_type = "private"
                        else:
                            chat_type = "unknown"

                        # 获取标题
                        title = getattr(entity, "title", None)
                        if not title and isinstance(entity, User):
                            title = " ".join(filter(None, [entity.first_name, entity.last_name]))
                            if not title and getattr(entity, "username", None):
                                title = f"@{entity.username}"

                        channel = TelegramChannel(
                            id=str(chat_id),
                            title=title or "Unknown",
                            type=chat_type,
                            username=getattr(entity, 'username', None),
                            member_count=getattr(entity, 'participants_count', None)
                        )
                        channels.append(channel.dict())

                    logger.info(f"Got {len(channels)} dialogs via Telethon for bot {account_id}")
                except Exception as e:
                    logger.warning(f"Failed to get dialogs via Telethon: {e}")

            # 方法2: 如果 Telethon 没有获取到，回退到 Bot API getUpdates
            if not channels:
                try:
                    url = f"https://api.telegram.org/bot{token}/getUpdates"
                    session = self._get_http_session()
                    async with session.get(url, params={"limit": 100}) as resp:
                        data = await resp.json()
                        if data.get("ok"):
                            for update in data.get("result", []):
                                chat = self._extract_bot_api_chat(update)
                                if not chat:
                                    continue
                                chat_id = chat.get("id")
                                if chat_id and chat_id not in seen_chat_ids:
                                    seen_chat_ids.add(chat_id)
                                    chat_type = chat.get("type", "private")
                                    channel = TelegramChannel(
                                        id=str(chat_id),
                                        title=chat.get("title") or chat.get("first_name") or "Unknown",
                                        type=chat_type,
                                        username=chat.get("username"),
                                        member_count=None
                                    )
                                    channels.append(channel.dict())
                        else:
                            error_msg = data.get("description", "Unknown error")
                            logger.warning(f"Bot API getUpdates error: {error_msg}")
                            if "webhook" in str(error_msg).lower():
                                note_parts.append("检测到该机器人已配置 Webhook。")
                except Exception as e:
                    logger.warning(f"Failed to get updates via Bot API: {e}")

            # 检查 Webhook 状态（用于提示）
            try:
                url = f"https://api.telegram.org/bot{token}/getWebhookInfo"
                session = self._get_http_session()
                async with session.get(url) as resp:
                    data = await resp.json()
                    if data.get("ok"):
                        info = data.get("result", {}) or {}
                        webhook_url = info.get("url")
                        if webhook_url:
                            note_parts.append("检测到该机器人已配置 Webhook，部分功能可能受限。")
            except Exception:
                pass

            try:
                url = f"https://api.telegram.org/bot{token}/getMe"
                session = self._get_http_session()
                async with session.get(url) as resp:
                    data = await resp.json()
                    if data.get("ok"):
                        info = data.get("result", {}) or {}
                        if info.get("can_read_all_group_messages") is False:
                            note_parts.append(
                                "该机器人当前仍处于隐私模式，群内普通消息不会全部可见；如需完整监听，请在 BotFather 关闭 Group Privacy 或改用客户端账号。"
                            )
            except Exception:
                pass

            if not channels:
                note_parts.append("未获取到对话列表。请确保机器人已被添加到群组或有用户私聊过机器人。")

            return {
                "success": True,
                "channels": channels,
                "note": " ".join(note_parts) if note_parts else None
            }

        except Exception as e:
            logger.error(f"Failed to get channels for bot {account_id}: {e}")
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
        watermark: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """发送消息 - 使用 Bot API 而不是 Telethon（避免实体缓存问题）"""
        try:
            logger.info(f"BotManager.send_message: account_id={account_id}, chat_id={chat_id}, message_len={len(message) if message else 0}, attachments_count={len(attachments) if attachments else 0}")

            # 检查 chat_id 是否有效
            if chat_id is None:
                return {
                    "success": False,
                    "error": "INVALID_CHAT_ID",
                    "message": "Chat ID is None"
                }

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

            # 如果有附件，使用对应的 API 发送
            if attachments and len(attachments) > 0:
                logger.info(f"Sending media with {len(attachments)} attachments, watermark={watermark is not None}")
                has_local = any(att.get("localPath") or att.get("path") for att in attachments)
                # 如果有水印或有本地文件，使用 _send_media_attachment（需要下载图片来应用水印）
                if has_local or watermark:
                    bot = self.bots.get(account_id)
                    if bot:
                        return await self._send_media_attachment(
                            bot,
                            chat_id,
                            attachments[0],
                            message if message else None,
                            reply_to_message_id,
                            watermark,
                        )
                return await self._send_media_via_bot_api(token, chat_id, message, attachments, parse_mode, reply_to_message_id)

            # 没有附件，使用 sendMessage API
            return await self._send_message_via_bot_api(token, chat_id, message, parse_mode, reply_to_message_id)

        except Exception as e:
            logger.error(f"Failed to send message for bot {account_id}: {e}")
            return {
                "success": False,
                "error": "SEND_MESSAGE_FAILED",
                "message": str(e)
            }

    async def _send_message_via_bot_api(
        self,
        token: str,
        chat_id: int,
        text: str,
        parse_mode: Optional[str] = None,
        reply_to_message_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """使用 Telegram Bot API 发送消息"""
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode
        if reply_to_message_id:
            payload["reply_to_message_id"] = reply_to_message_id

        try:
            session = self._get_http_session()
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

    async def _send_media_via_bot_api(
        self,
        token: str,
        chat_id: int,
        caption: str,
        attachments: List[Dict[str, Any]],
        parse_mode: Optional[str] = None,
        reply_to_message_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        """使用 Telegram Bot API 发送媒体消息"""
        try:
            # 获取第一个附件
            attachment = attachments[0]
            media_type = attachment.get("type", "document")
            media_url = attachment.get("url")

            if not media_url:
                logger.error("No media URL provided")
                return {
                    "success": False,
                    "error": "NO_MEDIA_URL",
                    "message": "No media URL provided"
                }

            # 根据媒体类型选择 API
            if media_type == "photo":
                api_method = "sendPhoto"
                media_key = "photo"
            elif media_type == "video":
                api_method = "sendVideo"
                media_key = "video"
            elif media_type == "audio":
                api_method = "sendAudio"
                media_key = "audio"
            else:
                api_method = "sendDocument"
                media_key = "document"

            url = f"https://api.telegram.org/bot{token}/{api_method}"
            payload = {
                "chat_id": chat_id,
                media_key: media_url
            }

            # caption 可以为空
            if caption:
                payload["caption"] = caption
            if parse_mode:
                payload["parse_mode"] = parse_mode
            if reply_to_message_id:
                payload["reply_to_message_id"] = reply_to_message_id

            session = self._get_http_session()
            async with session.post(url, json=payload) as resp:
                data = await resp.json()
                if data.get("ok"):
                    logger.info(f"Media sent via Bot API ({api_method}) to chat_id {chat_id}")
                    return {
                        "success": True,
                        "messageId": data["result"]["message_id"]
                    }
                else:
                    error_msg = data.get("description", "Unknown error")
                    logger.error(f"Bot API error ({api_method}): {error_msg}")
                    return {
                        "success": False,
                        "error": "BOT_API_ERROR",
                        "message": error_msg
                    }
        except Exception as e:
            logger.error(f"Failed to send media via Bot API: {e}")
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
            chat_title = getattr(message.chat, 'title', None)
            chat_type = getattr(message.chat, 'type', None)

            # 记录对话到缓存（即便未监听，也保留同步名单）
            self._record_dialog(account_id, chat_id, chat_title, chat_username, chat_type)

            # 只处理配置中监听的频道，忽略其他频道的消息
            if not self._is_watched_chat(account_id, chat_id, chat_username):
                count = self._unwatched_log_count.get(account_id, 0)
                if count < 3:
                    watched_ids = list(self._watched_chats.get(account_id, set()))
                    account_label = self._format_account_label(account_id)
                    logger.info(
                        f"忽略未监听聊天 | 账号={account_label} | chat_id={chat_id} | username={chat_username or ''} | 已监听={watched_ids}"
                    )
                    self._unwatched_log_count[account_id] = count + 1
                return

            account_label = self._format_account_label(account_id)
            logger.info(
                f"收到 Telegram 消息 | 账号={account_label} | chat_id={chat_id} | username={chat_username or ''} | id={getattr(message, 'id', '')}"
            )

            # 解析媒体信息
            media = []
            if message.media:
                media_info = self._parse_media(message.media)
                if media_info:
                    try:
                        media_type = media_info.get("type")
                        mime_type = str(media_info.get("mimeType") or "")
                        should_download = media_type == "photo" or (
                            media_type == "document" and mime_type.startswith("image/")
                        )
                        if should_download:
                            local_path = await self._download_media_file(event, message)
                            if local_path:
                                media_info["localPath"] = local_path
                                media_info["fileName"] = Path(local_path).name
                    except Exception as e:
                        logger.debug(f"Failed to download media for bot message {getattr(message, 'id', None)}: {e}")
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
            text_content = message.message or message.text or ""
            telegram_message = TelegramMessage(
                id=message.id,
                chat_id=message.chat_id,
                chat_title=getattr(message.chat, 'title', None),
                chat_username=getattr(message.chat, 'username', None),
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
                logger.debug(f"No message handler for bot {account_id}")

        except Exception as e:
            logger.error(f"Failed to handle message for bot {account_id}: {e}")

    async def _handle_chat_action(self, event, account_id: str):
        """记录机器人可见的群动作，避免新加群时同步列表为空"""
        try:
            chat = getattr(event, "chat", None)
            chat_id = getattr(event, "chat_id", None)
            if chat_id is None and chat is not None:
                chat_id = getattr(chat, "id", None)
            if chat_id is None:
                return

            chat_username = getattr(chat, "username", None) if chat is not None else None
            chat_title = getattr(chat, "title", None) if chat is not None else None
            if not chat_title and isinstance(chat, User):
                full_name = " ".join(filter(None, [chat.first_name, chat.last_name])).strip()
                chat_title = full_name or (f"@{chat.username}" if getattr(chat, "username", None) else None)
            chat_type = self._resolve_chat_type(chat)
            self._record_dialog(account_id, chat_id, chat_title, chat_username, chat_type)
        except Exception as e:
            logger.debug(f"Failed to record chat action for account {account_id}: {e}")

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

    async def update_config(self, accounts: List[Union[TelegramAccount, Dict[str, Any]]]):
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
