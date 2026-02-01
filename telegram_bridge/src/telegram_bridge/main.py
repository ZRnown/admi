#!/usr/bin/env python3
"""
Telegram Bridge Service 主入口
"""

import asyncio
import sys
import signal
import glob
import os
import json
from pathlib import Path
from loguru import logger
from .ipc import IPCServer
from .client import TelegramClientManager
from .bot import TelegramBotManager
from .connection import ConnectionManager
from .forwarder import TelegramForwarder


class TelegramBridgeService:
    """Telegram桥接服务"""

    def __init__(self, discord_sender=None):
        self.ipc_server = IPCServer()
        self.client_manager = TelegramClientManager()
        self.bot_manager = TelegramBotManager()
        self.forwarder = TelegramForwarder()
        self.running = False

        # 状态文件路径
        base_dir = Path(__file__).resolve().parents[3]
        self.status_file = base_dir / ".data" / "telegram_status.json"
        self.dialogs_cache_file = base_dir / ".data" / "telegram_dialogs_cache.json"
        self.status_file.parent.mkdir(parents=True, exist_ok=True)

        # 设置Discord发送器
        if discord_sender:
            self.forwarder.set_discord_sender(discord_sender)

        # 设置Telegram发送器
        self.forwarder.set_telegram_sender(self.client_manager, self.bot_manager)

        # 注册Telegram消息处理器（将Telegram消息转发到Discord）
        self._setup_telegram_message_handlers()

    def _cleanup_stale_locks(self):
        """清理残留的 session 锁文件"""
        try:
            base_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../.."))
            session_dir = os.path.join(base_dir, ".data", "telegram_sessions")

            if os.path.exists(session_dir):
                logger.info(f"Cleaning up stale session locks in {session_dir}...")
                patterns = ["*.session-journal", "*.session-wal"]
                for pattern in patterns:
                    for lock_file in glob.glob(os.path.join(session_dir, pattern)):
                        try:
                            os.remove(lock_file)
                            logger.info(f"Removed stale lock file: {lock_file}")
                        except Exception as e:
                            logger.warning(f"Could not remove {lock_file}: {e}")
        except Exception as e:
            logger.error(f"Error during lock cleanup: {e}")

    def _write_telegram_status(self, account_id: str, state: str, message: str = "", user_info: dict = None):
        """写入Telegram账号状态到文件"""
        try:
            if state == "online" and user_info:
                display_name = self._format_telegram_display_name(user_info)
                if display_name:
                    if not message or message in ["已连接", "连接成功", "connected", "online"]:
                        message = f"已连接: {display_name}"
                    elif display_name not in message:
                        message = f"{message}: {display_name}"

            # 读取现有状态
            status_data = {}
            if self.status_file.exists():
                try:
                    with open(self.status_file, "r", encoding="utf-8") as f:
                        status_data = json.load(f)
                except Exception:
                    pass

            # 更新状态
            status_data[account_id] = {
                "state": state,
                "message": message,
                "userInfo": user_info
            }

            # 写入文件
            with open(self.status_file, "w", encoding="utf-8") as f:
                json.dump(status_data, f, ensure_ascii=False, indent=2)

            logger.debug(f"Telegram status updated: {account_id} -> {state}")
        except Exception as e:
            logger.error(f"Failed to write telegram status: {e}")

    def _write_telegram_dialogs_cache(self, account_id: str, dialogs: list):
        """写入Telegram对话缓存到文件"""
        try:
            # 读取现有缓存
            cache_data = {}
            if self.dialogs_cache_file.exists():
                try:
                    with open(self.dialogs_cache_file, "r", encoding="utf-8") as f:
                        cache_data = json.load(f)
                except Exception:
                    pass

            # 更新缓存
            cache_data[account_id] = dialogs

            # 写入文件
            with open(self.dialogs_cache_file, "w", encoding="utf-8") as f:
                json.dump(cache_data, f, ensure_ascii=False, indent=2)

            logger.debug(f"Telegram dialogs cache updated: {account_id}")
        except Exception as e:
            logger.error(f"Failed to write telegram dialogs cache: {e}")

    @staticmethod
    def _format_telegram_display_name(user_info: dict) -> str:
        if not user_info:
            return ""
        username = user_info.get("username")
        if isinstance(username, str) and username.strip():
            return f"@{username.strip()}"
        display_name = user_info.get("displayName") or user_info.get("display_name")
        if isinstance(display_name, str) and display_name.strip():
            return display_name.strip()
        first_name = user_info.get("firstName") or user_info.get("first_name") or ""
        last_name = user_info.get("lastName") or user_info.get("last_name") or ""
        full_name = f"{first_name} {last_name}".strip()
        return full_name

    def _setup_telegram_message_handlers(self):
        """设置Telegram消息处理器"""
        async def on_telegram_message(account_id: str, message_data: dict):
            """处理接收到的Telegram消息"""
            try:
                logger.debug(f"收到 Telegram 消息: 账号={account_id} id={message_data.get('id')}")
                logger.debug(f"Telegram message payload: {message_data}")

                # 通过forwarder处理消息（它会根据mappings转发到Discord）
                from .telegram_types import TelegramMessage
                telegram_message = TelegramMessage(**message_data)

                # 如果未设置Discord发送器，则通知主进程进行转发
                if not getattr(self.forwarder, "discord_forwarder", None):
                    user_info = message_data.get("from_user") or {}
                    display_name = message_data.get("from_display_name") or user_info.get("displayName")
                    if not display_name:
                        display_name = (f"{user_info.get('firstName') or ''} {user_info.get('lastName') or ''}").strip()
                    if not display_name:
                        display_name = user_info.get("username")

                    payload = {
                        "accountId": account_id,
                        "id": message_data.get("id"),
                        "chat_title": message_data.get("chat_title"),
                        "chat_username": message_data.get("chat_username"),
                        "chat_id": message_data.get("chat_id"),
                        "text": message_data.get("text"),
                        "date": message_data.get("date"),
                        "from_username": user_info.get("username"),
                        "from_display_name": display_name,
                        "from_avatar_file": message_data.get("from_avatar_file") or user_info.get("avatarFile"),
                        "reply_to_message_id": message_data.get("reply_to_message_id"),
                        "reply_to": message_data.get("reply_to_message"),
                        "media": message_data.get("media")
                    }
                    await self.ipc_server.send_notification("telegram_message", payload)
                    logger.debug(f"IPC telegram_message payload sent: {payload}")
                    return

                # 调用forwarder的Telegram消息处理方法
                await self.forwarder.handle_telegram_message(telegram_message, account_id)

            except Exception as e:
                logger.error(f"Failed to handle Telegram message: {e}")

        # 为bot和client manager注册消息处理器
        # 注意：这里需要为每个账号动态注册，暂时先设置通用处理器
        # 实际注册在连接时通过bot_manager.message_handlers和client_manager.message_handlers
        self.on_telegram_message_callback = on_telegram_message


    async def start(self):
        """启动服务"""
        logger.info("Starting Telegram Bridge Service...")

        try:
            # 清理残留的锁文件
            self._cleanup_stale_locks()

            # 注册IPC处理器
            self._register_handlers()

            # 启动IPC服务器
            await self.ipc_server.start()

            self.running = True
            logger.info("Telegram Bridge Service started successfully")

            # 等待停止信号
            await self._wait_for_shutdown()

        except Exception as e:
            logger.error(f"Failed to start service: {e}")
            raise
        finally:
            await self._shutdown()

    async def _wait_for_shutdown(self):
        """等待关闭信号"""
        stop_event = asyncio.Event()

        def signal_handler(signum, frame):
            logger.info(f"Received signal {signum}, shutting down...")
            stop_event.set()

        # 注册信号处理器
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)

        await stop_event.wait()

    async def _shutdown(self):
        """关闭服务"""
        logger.info("Shutting down Telegram Bridge Service...")

        try:
            # 停止所有客户端连接
            await self.client_manager.disconnect_all()
            await self.bot_manager.disconnect_all()

            # 停止IPC服务器
            await self.ipc_server.stop()

            logger.info("Telegram Bridge Service shut down successfully")
        except Exception as e:
            logger.error(f"Error during shutdown: {e}")

    def _register_handlers(self):
        """注册IPC消息处理器"""
        async def wrap_connect_client(params):
            account_id = params.get("id") or params.get("accountId")
            self._write_telegram_status(account_id, "connecting", "正在连接...")
            result = await self.client_manager.connect(params)
            # 根据连接结果更新状态
            if result.get("success"):
                user_info = result.get("user_info") or result.get("userInfo")
                self._write_telegram_status(account_id, "online", "已连接", user_info)
                # 获取并缓存对话列表
                try:
                    channels_result = await self.client_manager.get_channels(account_id)
                    if channels_result.get("success"):
                        dialogs = channels_result.get("channels", [])
                        self._write_telegram_dialogs_cache(account_id, dialogs)
                except Exception as e:
                    logger.warning(f"Failed to cache dialogs for {account_id}: {e}")
            else:
                error_msg = result.get("message") or result.get("error") or "连接失败"
                self._write_telegram_status(account_id, "error", error_msg)
            return result

        async def wrap_connect_bot(params):
            account_id = params.get("id") or params.get("accountId")
            self._write_telegram_status(account_id, "connecting", "正在连接...")
            result = await self.bot_manager.connect(params)
            if result.get("success"):
                user_info = result.get("user_info") or result.get("userInfo")
                self._write_telegram_status(account_id, "online", "已连接", user_info)
                # 获取并缓存对话列表
                try:
                    channels_result = await self.bot_manager.get_channels(account_id)
                    if channels_result.get("success"):
                        dialogs = channels_result.get("channels", [])
                        self._write_telegram_dialogs_cache(account_id, dialogs)
                except Exception as e:
                    logger.warning(f"Failed to cache bot dialogs for {account_id}: {e}")
            else:
                error_msg = result.get("message") or result.get("error") or "连接失败"
                self._write_telegram_status(account_id, "error", error_msg)
            return result

        async def wrap_disconnect_client(params):
            account_id = params.get("accountId")
            result = await self.client_manager.disconnect(account_id)
            self._write_telegram_status(account_id, "idle", "已断开")
            return result

        async def wrap_get_client_status(params):
            return self.client_manager.get_status(params.get("accountId"))

        async def wrap_get_client_channels(params):
            return await self.client_manager.get_channels(params.get("accountId"))

        async def wrap_start_client_login(params):
            return await self.client_manager.start_login(params)

        async def wrap_confirm_client_login(params):
            return await self.client_manager.confirm_login(params)

        async def wrap_disconnect_bot(params):
            account_id = params.get("accountId")
            result = await self.bot_manager.disconnect(account_id)
            self._write_telegram_status(account_id, "idle", "已断开")
            return result

        async def wrap_get_bot_status(params):
            return self.bot_manager.get_status(params.get("accountId"))

        async def wrap_get_bot_channels(params):
            return await self.bot_manager.get_channels(params.get("accountId"))

        # 客户端管理
        self.ipc_server.register_handler("connectClient", wrap_connect_client)
        self.ipc_server.register_handler("disconnectClient", wrap_disconnect_client)
        self.ipc_server.register_handler("getClientStatus", wrap_get_client_status)
        self.ipc_server.register_handler("getClientChannels", wrap_get_client_channels)
        self.ipc_server.register_handler("startClientLogin", wrap_start_client_login)
        self.ipc_server.register_handler("confirmClientLogin", wrap_confirm_client_login)

        # 机器人管理
        self.ipc_server.register_handler("connectBot", wrap_connect_bot)
        self.ipc_server.register_handler("disconnectBot", wrap_disconnect_bot)
        self.ipc_server.register_handler("getBotStatus", wrap_get_bot_status)
        self.ipc_server.register_handler("getBotChannels", wrap_get_bot_channels)

        # 消息发送
        self.ipc_server.register_handler("sendMessage", self._handle_send_message)

        # 配置更新
        self.ipc_server.register_handler("updateConfig", self._handle_update_config)

        # Telegram消息处理（从客户端/机器人接收）
        self.ipc_server.register_handler("handleTelegramMessage", self._handle_telegram_message)
        self.ipc_server.register_handler("handleDiscordMessage", self._handle_discord_message)

    async def _handle_send_message(self, params):
        """处理消息发送"""
        account_id = params.get("accountId")
        account_type = params.get("accountType", "client")
        chat_id = params.get("chatId")
        message = params.get("message")
        media = params.get("media")

        text = message
        parse_mode = None
        reply_to_message_id = None
        watermark = None
        if isinstance(message, dict):
            text = message.get("text") or ""
            parse_mode = message.get("parse_mode")
            reply_to_message_id = message.get("reply_to_message_id")
            watermarks = message.get("watermarks")
            if watermarks is not None:
                watermark = watermarks
            else:
                primary = message.get("watermark")
                secondary = message.get("watermarkSecondary")
                if secondary is not None:
                    merged = []
                    if isinstance(primary, list):
                        merged.extend([w for w in primary if isinstance(w, dict)])
                    elif isinstance(primary, dict):
                        merged.append(primary)
                    if isinstance(secondary, list):
                        merged.extend([w for w in secondary if isinstance(w, dict)])
                    elif isinstance(secondary, dict):
                        merged.append(secondary)
                    if len(merged) == 1:
                        watermark = merged[0]
                    elif len(merged) > 1:
                        watermark = merged
                    else:
                        watermark = primary
                else:
                    watermark = primary

        # 统一规范 chat_id（允许传入字符串）
        if isinstance(chat_id, str):
            trimmed = chat_id.strip()
            if trimmed.startswith("https://t.me/"):
                trimmed = trimmed.split("/")[-1]
            if trimmed.startswith("@"):
                trimmed = trimmed[1:]
            if trimmed.lstrip("-").isdigit():
                try:
                    chat_id = int(trimmed)
                except Exception:
                    chat_id = trimmed
            else:
                chat_id = trimmed

        if account_type == "client":
            return await self.client_manager.send_message(
                account_id,
                chat_id,
                text,
                media,
                parse_mode,
                reply_to_message_id,
                watermark,
            )
        else:
            return await self.bot_manager.send_message(
                account_id,
                chat_id,
                text,
                media,
                parse_mode,
                reply_to_message_id,
                watermark,
            )

    async def _handle_update_config(self, params):
        """处理配置更新"""
        from .telegram_types import TelegramAccount, TelegramMapping

        accounts_data = params.get("accounts", [])
        mappings_data = params.get("mappings", [])

        # 将字典转换为对象
        accounts = [TelegramAccount(**acc) if isinstance(acc, dict) else acc for acc in accounts_data]
        mappings = [TelegramMapping(**m) if isinstance(m, dict) else m for m in mappings_data]

        # 更新客户端配置（会自动连接启用的账号）
        await self.client_manager.update_config(accounts)
        await self.bot_manager.update_config(accounts)

        # 更新映射配置
        self.forwarder.update_config(accounts, mappings)

        # 写入每个账号的连接状态到文件
        for account in accounts:
            account_id = getattr(account, "id", None)
            if not account_id:
                continue
            account_type = getattr(account, "type", "client")

            if account_type == "bot":
                status = self.bot_manager.get_status(account_id)
            else:
                status = self.client_manager.get_status(account_id)

            if status:
                state = "online" if status.status.value == "connected" else status.status.value
                self._write_telegram_status(account_id, state, status.error_message or "", status.user_info)
            elif account.enabled:
                self._write_telegram_status(account_id, "idle", "等待连接")

        # 为每个Telegram账号注册消息处理器，并更新监听的频道列表
        self.bot_manager.message_handlers = {}
        self.client_manager.message_handlers = {}

        # 构建每个账号需要监听的频道列表
        account_watched_chats: dict = {}  # account_id -> set of chat_ids/usernames

        # 1. 先为所有账号初始化空集合（关键修复：确保没有规则的账号被清空）
        for account in accounts:
            account_id = getattr(account, "id", None)
            if account_id:
                account_watched_chats[account_id] = set()

        # 2. 填充有规则的监听列表
        for mapping in mappings:
            if mapping.type not in ["telegram-to-discord", "telegram-to-telegram"]:
                continue
            raw_id = mapping.source_channel_id
            chat_id = None
            if isinstance(raw_id, str):
                raw_id = raw_id.strip()
            if raw_id:
                try:
                    chat_id = int(raw_id)
                except (ValueError, TypeError):
                    if isinstance(raw_id, str):
                        # 统一转小写以便匹配
                        chat_id = raw_id.lstrip("@").strip().lower()
            if not chat_id:
                continue

            for account in accounts:
                if not account.enabled:
                    continue
                account_id = getattr(account, "id", None)
                if not account_id:
                    continue
                account_watched_chats[account_id].add(chat_id)

        # 3. 应用监听列表并注册处理器
        for account in accounts:
            if not account.enabled:
                continue
            account_id = getattr(account, "id", None)
            if not account_id:
                logger.warning("Skipping telegram account without id")
                continue

            async def handler(msg_data, acc_id=account_id):
                await self.on_telegram_message_callback(acc_id, msg_data)

            # 获取该账号应该监听的频道列表（如果没有规则，这里就是空列表）
            watched_chats = list(account_watched_chats.get(account_id, []))

            if getattr(account, "type", None) == "bot":
                self.bot_manager.message_handlers[account_id] = handler
                self.bot_manager.update_watched_chats(account_id, watched_chats)
                logger.info(f"机器人账号 {account_id} 监听 {len(watched_chats)} 个聊天")
            else:
                self.client_manager.message_handlers[account_id] = handler
                self.client_manager.update_watched_chats(account_id, watched_chats)
                logger.info(f"客户端账号 {account_id} 监听 {len(watched_chats)} 个聊天")

        return {"success": True}

    async def _handle_telegram_message(self, params):
        """处理接收到的Telegram消息"""
        try:
            telegram_account_id = params.get("accountId")
            message_data = params.get("message")

            if not telegram_account_id or not message_data:
                return {"success": False, "error": "Missing accountId or message"}

            # 转换消息格式
            from .telegram_types import TelegramMessage
            message = TelegramMessage(**message_data)

            # 处理转发
            await self.forwarder.handle_telegram_message(message, telegram_account_id)

            return {"success": True}

        except Exception as e:
            logger.error(f"Failed to handle Telegram message: {e}")
            return {"success": False, "error": str(e)}

    async def _handle_discord_message(self, params):
        """处理接收到的Discord消息"""
        try:
            discord_channel_id = params.get("channelId")
            message_data = params.get("message")

            if not discord_channel_id or not message_data:
                return {"success": False, "error": "Missing channelId or message"}

            # 处理Discord消息转发
            await self.forwarder.handle_discord_message(message_data, discord_channel_id)

            return {"success": True}

        except Exception as e:
            logger.error(f"Failed to handle Discord message: {e}")
            return {"success": False, "error": str(e)}


async def main():
    """主函数"""
    # 配置日志
    logger.remove()
    logger.add(sys.stderr, level="INFO", format="{time} {level} {message}")
    logger.add("logs/telegram-bridge-{time}.log", rotation="1 day", level="DEBUG")

    # 创建并启动服务
    service = TelegramBridgeService()
    await service.start()


if __name__ == "__main__":
    asyncio.run(main())
