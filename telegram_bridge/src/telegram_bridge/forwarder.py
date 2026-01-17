"""
Discord转发器
负责将转换后的Telegram消息转发到Discord
"""

import asyncio
from typing import Dict, List, Optional, Any
from loguru import logger
from .types import TelegramMessage, TelegramMapping
from .message_converter import TelegramToDiscordConverter, DiscordToTelegramConverter, ConversionConfig


class DiscordForwarder:
    """Discord转发器"""

    def __init__(self, discord_sender):
        """
        初始化转发器

        Args:
            discord_sender: Discord发送器实例（SenderBot）
        """
        self.discord_sender = discord_sender
        self.converters: Dict[str, TelegramToDiscordConverter] = {}

    def update_config(self, accounts: List[Dict[str, Any]]):
        """更新配置"""
        try:
            # 为每个账号创建转换器
            for account in accounts:
                telegram_config = account.get("telegramConfig", {})
                if telegram_config and telegram_config.get("accounts"):
                    for tg_account in telegram_config["accounts"]:
                        converter_config = ConversionConfig(
                            enable_translation=account.enableTranslation or False,
                            translation_provider=account.translationProvider or "deepseek",
                            translation_api_key=account.translationApiKey or account.deepseekApiKey,
                            blocked_keywords=account.blockedKeywords or [],
                            exclude_keywords=account.excludeKeywords or [],
                            allowed_users=account.allowedUsersIds,
                            muted_users=account.mutedUsersIds,
                            show_source_identity=account.showSourceIdentity or False,
                            replacements=account.replacementsDictionary
                        )

                        converter = TelegramToDiscordConverter(converter_config)
                        self.converters[tg_account.id] = converter

            logger.info(f"Updated Discord forwarder config for {len(self.converters)} Telegram accounts")

        except Exception as e:
            logger.error(f"Failed to update Discord forwarder config: {e}")

    async def forward_message(
        self,
        telegram_message: TelegramMessage,
        telegram_account_id: str,
        mappings: List[TelegramMapping],
        filter_rules: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        转发Telegram消息到Discord

        Args:
            telegram_message: Telegram消息
            telegram_account_id: Telegram账号ID
            mappings: 映射配置列表
            filter_rules: 过滤规则

        Returns:
            转发结果统计
        """
        try:
            results = {
                "total_mappings": len(mappings),
                "successful_forwards": 0,
                "failed_forwards": 0,
                "filtered_messages": 0,
                "details": []
            }

            # 获取对应的转换器
            converter = self.converters.get(telegram_account_id)
            if not converter:
                logger.warning(f"No converter found for Telegram account {telegram_account_id}")
                results["failed_forwards"] = len(mappings)
                return results

            # 处理每个映射
            for mapping in mappings:
                try:
                    # 检查映射类型
                    if mapping.type != "telegram-to-discord":
                        continue

                    # 检查源频道是否匹配
                    source_channel_id = str(telegram_message.chat_id)
                    if mapping.source_channel_id != source_channel_id:
                        continue

                    # 转换消息
                    discord_message = await converter.convert_and_filter(
                        telegram_message,
                        mapping,
                        filter_rules
                    )

                    if discord_message is None:
                        # 消息被过滤
                        results["filtered_messages"] += 1
                        results["details"].append({
                            "mapping_id": mapping.id,
                            "target_channel": mapping.target_channel_id,
                            "status": "filtered",
                            "reason": "Message filtered by rules"
                        })
                        continue

                    # 发送到Discord
                    send_result = await self._send_to_discord(
                        discord_message,
                        mapping.targetChannelId,
                        telegram_message
                    )

                    if send_result["success"]:
                        results["successful_forwards"] += 1
                        results["details"].append({
                            "mapping_id": mapping.id,
                            "target_channel": mapping.target_channel_id,
                            "status": "success",
                            "discord_message_id": send_result.get("message_id")
                        })
                    else:
                        results["failed_forwards"] += 1
                    results["details"].append({
                        "mapping_id": mapping.id,
                        "target_channel": mapping.target_channel_id,
                        "status": "failed",
                        "error": send_result.get("error")
                    })

                except Exception as e:
                    logger.error(f"Failed to forward message via mapping {mapping.id}: {e}")
                    results["failed_forwards"] += 1
                    results["details"].append({
                        "mapping_id": mapping.id,
                        "target_channel": mapping.target_channel_id,
                        "status": "error",
                        "error": str(e)
                    })

            return results

        except Exception as e:
            logger.error(f"Failed to forward Telegram message: {e}")
            return {
                "total_mappings": len(mappings),
                "successful_forwards": 0,
                "failed_forwards": len(mappings),
                "filtered_messages": 0,
                "details": [{"status": "error", "error": str(e)}]
            }

    async def _send_to_discord(
        self,
        discord_message: Dict[str, Any],
        target_channel_id: str,
        original_message: TelegramMessage
    ) -> Dict[str, Any]:
        """发送消息到Discord"""
        try:
            # 构建SenderBot消息格式
            messages_to_send = [{
                "content": discord_message.get("content", ""),
                "sourceMessageId": str(original_message.id),
                "username": discord_message.get("username"),
                "avatarUrl": discord_message.get("avatar_url"),
                "uploads": self._process_attachments(discord_message.get("attachments", [])),
                "enableTranslationOverride": False,  # Telegram消息已处理翻译
            }]

            # 发送消息
            results = await self.discord_sender.sendData(messages_to_send)

            if results and len(results) > 0:
                result = results[0]
                return {
                    "success": True,
                    "message_id": result.get("targetMessageId"),
                    "channel_id": result.get("targetChannelId")
                }
            else:
                return {
                    "success": False,
                    "error": "No response from Discord sender"
                }

        except Exception as e:
            logger.error(f"Failed to send message to Discord: {e}")
            return {
                "success": False,
                "error": str(e)
            }

    def _process_attachments(self, attachments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """处理附件"""
        try:
            uploads = []

            for attachment in attachments:
                media_type = attachment.get("type")
                file_id = attachment.get("file_id")

                if not file_id:
                    continue

                # TODO: 从Telegram下载文件并上传到Discord
                # 这里暂时只返回基本信息，实际实现需要下载文件
                upload = {
                    "filename": attachment.get("file_name", f"file_{file_id}"),
                    "url": f"telegram_file://{file_id}",  # 占位符URL
                    "isImage": media_type in ["photo", "sticker"],
                    "isVideo": media_type == "video"
                }

                uploads.append(upload)

            return uploads

        except Exception as e:
            logger.error(f"Failed to process attachments: {e}")
            return []


class TelegramSender:
    """Telegram消息发送器"""

    def __init__(self, client_manager=None, bot_manager=None):
        """
        初始化Telegram发送器

        Args:
            client_manager: TelegramClientManager实例
            bot_manager: TelegramBotManager实例
        """
        self.client_manager = client_manager
        self.bot_manager = bot_manager

    def update_managers(self, client_manager=None, bot_manager=None):
        """更新管理器引用"""
        if client_manager:
            self.client_manager = client_manager
        if bot_manager:
            self.bot_manager = bot_manager

    async def send_message(
        self,
        account_id: str,
        account_type: str,
        message_data: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        发送消息到Telegram

        Args:
            account_id: 账号ID
            account_type: 账号类型 ('client' 或 'bot')
            message_data: 消息数据

        Returns:
            发送结果
        """
        try:
            chat_id = message_data.get("chat_id")
            text = message_data.get("text", "")
            parse_mode = message_data.get("parse_mode")
            reply_to_message_id = message_data.get("reply_to_message_id")
            attachments = message_data.get("attachments", [])

            if account_type == "client" and self.client_manager:
                return await self.client_manager.send_message(
                    account_id, chat_id, text, attachments, parse_mode
                )
            elif account_type == "bot" and self.bot_manager:
                return await self.bot_manager.send_message(
                    account_id, chat_id, text, attachments, parse_mode
                )
            else:
                return {
                    "success": False,
                    "error": "INVALID_ACCOUNT_TYPE",
                    "message": f"Unsupported account type: {account_type}"
                }

        except Exception as e:
            logger.error(f"Failed to send message to Telegram: {e}")
            return {
                "success": False,
                "error": "SEND_FAILED",
                "message": str(e)
            }


class TelegramForwarder:
    """Telegram转发器总控制器"""

    def __init__(self):
        self.discord_forwarder: Optional[DiscordForwarder] = None
        self.telegram_sender: Optional[TelegramSender] = None
        self.account_configs: List[Dict[str, Any]] = []
        self.mappings: List[TelegramMapping] = []

    def set_discord_sender(self, discord_sender):
        """设置Discord发送器"""
        self.discord_forwarder = DiscordForwarder(discord_sender)

    def set_telegram_sender(self, client_manager=None, bot_manager=None):
        """设置Telegram发送器"""
        self.telegram_sender = TelegramSender(client_manager, bot_manager)

    def update_config(self, accounts: List[Dict[str, Any]], mappings: List[TelegramMapping]):
        """更新配置"""
        self.account_configs = accounts
        self.mappings = mappings

        if self.discord_forwarder:
            self.discord_forwarder.update_config(accounts)

    async def handle_telegram_message(
        self,
        telegram_message: TelegramMessage,
        telegram_account_id: str
    ):
        """处理接收到的Telegram消息"""
        try:
            if not self.discord_forwarder:
                logger.warning("Discord forwarder not initialized")
                return

            # 获取相关的映射配置
            relevant_mappings = [
                mapping for mapping in self.mappings
                if mapping.type == "telegram-to-discord" and
                mapping.source_channel_id == str(telegram_message.chat_id)
            ]

            if not relevant_mappings:
                logger.debug(f"No relevant mappings found for chat {telegram_message.chat_id}")
                return

            # 获取账号配置（用于过滤规则）
            account_config = None
            for account in self.account_configs:
                telegram_config = account.get("telegramConfig", {})
                if telegram_config and telegram_config.get("accounts"):
                    if any(tg_acc["id"] == telegram_account_id for tg_acc in telegram_config["accounts"]):
                        account_config = account
                        break

            # 构建过滤规则
            filter_rules = {}
            if account_config:
                filter_rules = {
                    "ignore_self": account_config.ignoreSelf,
                    "ignore_bot": account_config.ignoreBot,
                    "ignore_images": account_config.ignoreImages,
                    "ignore_audio": account_config.ignoreAudio,
                    "ignore_video": account_config.ignoreVideo,
                    "ignore_documents": account_config.ignoreDocuments,
                }

            # 转发消息
            results = await self.discord_forwarder.forward_message(
                telegram_message,
                telegram_account_id,
                relevant_mappings,
                filter_rules
            )

            logger.info(f"Forwarded Telegram message {telegram_message.id}: {results['successful_forwards']} success, {results['failed_forwards']} failed, {results['filtered_messages']} filtered")

        except Exception as e:
            logger.error(f"Failed to handle Telegram message: {e}")

    async def handle_discord_message(
        self,
        discord_message: Dict[str, Any],
        discord_channel_id: str
    ):
        """处理接收到的Discord消息"""
        try:
            if not self.telegram_sender:
                logger.warning("Telegram sender not initialized")
                return

            # 获取相关的映射配置
            relevant_mappings = [
                mapping for mapping in self.mappings
                if mapping.type == "discord-to-telegram" and
                mapping.source_channel_id == discord_channel_id
            ]

            if not relevant_mappings:
                logger.debug(f"No relevant mappings found for Discord channel {discord_channel_id}")
                return

            results = {
                "total_mappings": len(relevant_mappings),
                "successful_forwards": 0,
                "failed_forwards": 0,
                "details": []
            }

            # 为每个映射转发消息
            for mapping in relevant_mappings:
                try:
                    # 查找对应的Telegram账号
                    telegram_account = None
                    for account in self.account_configs:
                        telegram_config = account.get("telegramConfig", {})
                        if telegram_config and telegram_config.get("accounts"):
                            for tg_acc in telegram_config["accounts"]:
                                if tg_acc["id"] == mapping.target_channel_id.split('_')[0]:  # 简化账号匹配
                                    telegram_account = tg_acc
                                    break
                            if telegram_account:
                                break

                    if not telegram_account:
                        results["details"].append({
                            "mapping_id": mapping.id,
                            "status": "failed",
                            "error": "Telegram account not found"
                        })
                        results["failed_forwards"] += 1
                        continue

                    # 转换消息
                    telegram_message_data = await self._convert_discord_to_telegram(
                        discord_message, mapping, telegram_account
                    )

                    if not telegram_message_data:
                        results["details"].append({
                            "mapping_id": mapping.id,
                            "status": "failed",
                            "error": "Message conversion failed"
                        })
                        results["failed_forwards"] += 1
                        continue

                    # 发送到Telegram
                    send_result = await self.telegram_sender.send_message(
                        telegram_account["id"],
                        telegram_account["type"],
                        telegram_message_data
                    )

                    if send_result.get("success"):
                        results["successful_forwards"] += 1
                        results["details"].append({
                            "mapping_id": mapping.id,
                            "status": "success",
                            "telegram_message_id": send_result.get("messageId")
                        })
                    else:
                        results["failed_forwards"] += 1
                        results["details"].append({
                            "mapping_id": mapping.id,
                            "status": "failed",
                            "error": send_result.get("error")
                        })

                except Exception as e:
                    logger.error(f"Failed to forward Discord message via mapping {mapping.id}: {e}")
                    results["failed_forwards"] += 1
                    results["details"].append({
                        "mapping_id": mapping.id,
                        "status": "error",
                        "error": str(e)
                    })

            logger.info(f"Forwarded Discord message to Telegram: {results['successful_forwards']} success, {results['failed_forwards']} failed")

        except Exception as e:
            logger.error(f"Failed to handle Discord message: {e}")

    async def _convert_discord_to_telegram(
        self,
        discord_message: Dict[str, Any],
        mapping: TelegramMapping,
        telegram_account: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        """转换Discord消息为Telegram格式"""
        try:
            from .message_converter import DiscordToTelegramConverter, ConversionConfig

            # 创建转换器配置
            config = ConversionConfig(
                enable_translation=False,  # TODO: 从账号配置中获取
                show_source_identity=True
            )
            converter = DiscordToTelegramConverter(config)

            # 转换消息
            return await converter.convert_discord_to_telegram(discord_message, mapping)

        except Exception as e:
            logger.error(f"Failed to convert Discord message: {e}")
            return None
