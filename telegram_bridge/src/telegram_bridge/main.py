#!/usr/bin/env python3
"""
Telegram Bridge Service 主入口
"""

import asyncio
import sys
import signal
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

        # 设置Discord发送器
        if discord_sender:
            self.forwarder.set_discord_sender(discord_sender)

        # 设置Telegram发送器
        self.forwarder.set_telegram_sender(self.client_manager, self.bot_manager)

    async def start(self):
        """启动服务"""
        logger.info("Starting Telegram Bridge Service...")

        try:
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
        # 客户端管理
        self.ipc_server.register_handler("connectClient", self.client_manager.connect)
        self.ipc_server.register_handler("disconnectClient", self.client_manager.disconnect)
        self.ipc_server.register_handler("getClientStatus", self.client_manager.get_status)
        self.ipc_server.register_handler("getClientChannels", self.client_manager.get_channels)

        # 机器人管理
        self.ipc_server.register_handler("connectBot", self.bot_manager.connect)
        self.ipc_server.register_handler("disconnectBot", self.bot_manager.disconnect)
        self.ipc_server.register_handler("getBotStatus", self.bot_manager.get_status)
        self.ipc_server.register_handler("getBotChannels", self.bot_manager.get_channels)

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

        if account_type == "client":
            return await self.client_manager.send_message(account_id, chat_id, message, media)
        else:
            return await self.bot_manager.send_message(account_id, chat_id, message, media)

    async def _handle_update_config(self, params):
        """处理配置更新"""
        accounts = params.get("accounts", [])
        mappings = params.get("mappings", [])

        # 更新客户端配置
        await self.client_manager.update_config(accounts)
        await self.bot_manager.update_config(accounts)

        # 更新映射配置
        mappings = params.get("mappings", [])
        self.forwarder.update_config(accounts, mappings)

        return {"success": True}

    async def _handle_telegram_message(self, params):
        """处理接收到的Telegram消息"""
        try:
            telegram_account_id = params.get("accountId")
            message_data = params.get("message")

            if not telegram_account_id or not message_data:
                return {"success": False, "error": "Missing accountId or message"}

            # 转换消息格式
            from .types import TelegramMessage
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
