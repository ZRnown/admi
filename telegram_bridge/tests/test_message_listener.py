#!/usr/bin/env python3
"""
消息监听器集成测试
"""

import pytest
import asyncio
import json
from unittest.mock import Mock, AsyncMock
from telegram_bridge.client import TelegramClientManager
from telegram_bridge.bot import TelegramBotManager
from telegram_bridge.types import TelegramAccount, AccountType, TelegramMessage


@pytest.mark.asyncio
class TestMessageListener:
    """消息监听器测试"""

    async def setup_method(self):
        """测试前准备"""
        self.client_manager = TelegramClientManager()
        self.bot_manager = TelegramBotManager()

    async def test_client_message_handler_registration(self):
        """测试客户端消息处理器注册"""
        account_id = "test_client"
        received_messages = []

        async def message_handler(message_data):
            received_messages.append(message_data)

        # 注册消息处理器
        self.client_manager.message_handlers[account_id] = message_handler

        # 模拟消息事件
        mock_event = Mock()
        mock_message = Mock()
        mock_message.id = 12345
        mock_message.chat_id = -1001234567890
        mock_message.text = "Test message"
        mock_message.date.timestamp.return_value = 1640995200.0  # 2022-01-01 00:00:00 UTC
        mock_message.from_user = None
        mock_message.chat.title = "Test Chat"
        mock_message.chat.username = None
        mock_message.media = None
        mock_message.reply_to_msg_id = None
        mock_event.message = mock_message

        # 处理消息
        await self.client_manager._handle_message(mock_event, account_id)

        # 验证消息被接收
        assert len(received_messages) == 1
        message_data = received_messages[0]

        assert message_data["id"] == 12345
        assert message_data["chat_id"] == -1001234567890
        assert message_data["text"] == "Test message"
        assert message_data["chat_title"] == "Test Chat"
        assert message_data["date"] == 1640995200

    async def test_bot_message_handler_registration(self):
        """测试机器人消息处理器注册"""
        account_id = "test_bot"
        received_messages = []

        async def message_handler(message_data):
            received_messages.append(message_data)

        # 注册消息处理器
        self.bot_manager.message_handlers[account_id] = message_handler

        # 模拟消息事件
        mock_event = Mock()
        mock_message = Mock()
        mock_message.id = 67890
        mock_message.chat_id = -1009876543210
        mock_message.text = "Bot test message"
        mock_message.date.timestamp.return_value = 1641081600.0
        mock_message.from_user = Mock()
        mock_message.from_user.id = 123456789
        mock_message.from_user.first_name = "Test"
        mock_message.from_user.last_name = "User"
        mock_message.from_user.username = "testuser"
        mock_message.chat.title = "Bot Test Chat"
        mock_message.chat.username = None
        mock_message.media = None
        mock_message.reply_to_msg_id = None
        mock_event.message = mock_message

        # 处理消息
        await self.bot_manager._handle_message(mock_event, account_id)

        # 验证消息被接收
        assert len(received_messages) == 1
        message_data = received_messages[0]

        assert message_data["id"] == 67890
        assert message_data["chat_id"] == -1009876543210
        assert message_data["text"] == "Bot test message"
        assert message_data["chat_title"] == "Bot Test Chat"
        assert message_data["from_user"]["id"] == 123456789
        assert message_data["from_user"]["firstName"] == "Test"
        assert message_data["from_user"]["username"] == "testuser"

    async def test_media_message_parsing(self):
        """测试媒体消息解析"""
        # 测试客户端媒体解析
        mock_media = Mock()
        mock_photo = Mock()
        mock_photo.id = 123456789
        mock_photo.size = 1024000
        mock_media.photo = mock_photo

        result = self.client_manager._parse_media(mock_media)
        assert result is not None
        assert result["type"] == "photo"
        assert result["fileId"] == 123456789
        assert result["size"] == 1024000
        assert result["mimeType"] == "image/jpeg"

        # 测试机器人媒体解析
        result = self.bot_manager._parse_media(mock_media)
        assert result is not None
        assert result["type"] == "photo"

    async def test_user_parsing(self):
        """测试用户信息解析"""
        # 测试客户端用户解析
        mock_user = Mock()
        mock_user.id = 987654321
        mock_user.first_name = "John"
        mock_user.last_name = "Doe"
        mock_user.username = "johndoe"

        result = self.client_manager._parse_user(mock_user)
        assert result is not None
        assert result["id"] == 987654321
        assert result["firstName"] == "John"
        assert result["lastName"] == "Doe"
        assert result["username"] == "johndoe"

        # 测试机器人用户解析
        result = self.bot_manager._parse_user(mock_user)
        assert result is not None
        assert result["id"] == 987654321

    async def test_message_filtering(self):
        """测试消息过滤"""
        account_id = "test_bot_filter"
        received_messages = []

        async def message_handler(message_data):
            received_messages.append(message_data)

        # 注册消息处理器
        self.bot_manager.message_handlers[account_id] = message_handler

        # 模拟机器人自己的消息
        mock_event = Mock()
        mock_message = Mock()
        mock_message.id = 11111
        mock_message.chat_id = -1001111111111
        mock_message.text = "Bot's own message"
        mock_message.date.timestamp.return_value = 1641168000.0
        mock_message.from_user = Mock()
        mock_message.from_user.id = 555666777  # 机器人自己的ID
        mock_message.chat.title = "Test Chat"
        mock_message.media = None
        mock_message.reply_to_msg_id = None
        mock_event.message = mock_message

        # Mock get_me() 返回机器人信息
        mock_bot = AsyncMock()
        mock_me = Mock()
        mock_me.id = 555666777  # 与消息发送者ID相同
        mock_bot.get_me.return_value = mock_me
        self.bot_manager.bots[account_id] = mock_bot

        # 处理消息 - 应该被过滤掉
        await self.bot_manager._handle_message(mock_event, account_id)

        # 验证消息被过滤（没有收到）
        assert len(received_messages) == 0


if __name__ == "__main__":
    # 运行测试
    pytest.main([__file__, "-v"])
