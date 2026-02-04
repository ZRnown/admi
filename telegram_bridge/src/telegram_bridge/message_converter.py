"""
消息格式转换器
负责将Telegram消息转换为Discord格式，并应用过滤规则
"""

import re
import html
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass
from loguru import logger
from .telegram_types import TelegramMessage, TelegramMapping


@dataclass
class ConversionConfig:
    """转换配置"""
    enable_translation: bool = False
    translation_provider: str = "deepseek"
    translation_api_key: Optional[str] = None
    blocked_keywords: Optional[List[str]] = None
    exclude_keywords: Optional[List[str]] = None
    allowed_users: Optional[List[int]] = None
    muted_users: Optional[List[int]] = None
    show_source_identity: bool = False
    replacements: Optional[Dict[str, str]] = None
    # Telegram特有配置
    telegramLongMessage: Optional[Dict[str, Any]] = None


class MessageConverter:
    """消息转换器"""

    def __init__(self, config: ConversionConfig):
        self.config = config

    async def convert_telegram_to_discord(
        self,
        telegram_message: TelegramMessage,
        mapping: TelegramMapping
    ) -> Optional[Dict[str, Any]]:
        """
        将Telegram消息转换为Discord格式

        Args:
            telegram_message: Telegram消息
            mapping: 映射配置

        Returns:
            Discord消息格式的字典，如果消息被过滤则返回None
        """
        try:
            # 1. 应用过滤规则
            if not await self._should_forward_message(telegram_message, mapping):
                return None

            # 2. 构建基础消息内容
            content = await self._build_message_content(telegram_message, mapping)

            # 3. 处理媒体附件
            attachments = await self._process_media_attachments(telegram_message)

            # 4. 构建Discord消息
            discord_message = {
                "content": content,
                "username": None,  # 将在转发时设置
                "avatar_url": None,  # 将在转发时设置
                "embeds": [],  # 暂不支持embed
                "attachments": attachments
            }

            return discord_message

        except Exception as e:
            logger.error(f"Failed to convert Telegram message to Discord format: {e}")
            return None

    async def _should_forward_message(
        self,
        message: TelegramMessage,
        mapping: TelegramMapping
    ) -> bool:
        """检查消息是否应该被转发"""
        try:
            # 检查用户过滤
            if message.from_user:
                user_id = message.from_user.get("id")

                # 检查是否在屏蔽用户列表中
                if self.config.muted_users and user_id in self.config.muted_users:
                    return False

                # 检查是否只允许特定用户
                if self.config.allowed_users and user_id not in self.config.allowed_users:
                    return False

            # 检查关键词过滤
            text_to_check = message.text or ""
            if message.media:
                # 包含媒体描述
                for media in message.media:
                    if media.get("caption"):
                        text_to_check += " " + media["caption"]

            # 检查屏蔽关键词
            if self.config.blocked_keywords:
                for keyword in self.config.blocked_keywords:
                    if keyword.lower() in text_to_check.lower():
                        logger.info(f"Message blocked due to keyword: {keyword}")
                        return False

            # 检查排除关键词（从消息中移除而不是屏蔽）
            if self.config.exclude_keywords:
                for keyword in self.config.exclude_keywords:
                    text_to_check = re.sub(
                        re.escape(keyword),
                        "",
                        text_to_check,
                        flags=re.IGNORECASE
                    )

            return True

        except Exception as e:
            logger.error(f"Error checking message filter: {e}")
            return False

    async def _build_message_content(
        self,
        message: TelegramMessage,
        mapping: TelegramMapping
    ) -> str:
        """构建消息内容"""
        try:
            content_parts = []

            # 添加来源标识
            if self.config.show_source_identity and message.from_user:
                user_info = message.from_user
                display_name = user_info.get("username") or f"{user_info.get('firstName', '')} {user_info.get('lastName', '')}".strip()
                if display_name:
                    content_parts.append(f"**{display_name}**: ")

            # 处理翻译
            text = message.text or ""

            if mapping.translate and self.config.enable_translation:
                # TODO: 实现翻译功能
                pass

            # 应用替换规则
            if self.config.replacements:
                for old_text, new_text in self.config.replacements.items():
                    text = text.replace(old_text, new_text)

            # 处理媒体描述
            if message.media:
                for media in message.media:
                    if media.get("caption"):
                        text += f"\n{media['caption']}"

            content_parts.append(text)

            # 处理回复
            if message.reply_to_message_id:
                content_parts.append(f"\n*(回复消息 ID: {message.reply_to_message_id})*")

            return "".join(content_parts).strip()

        except Exception as e:
            logger.error(f"Error building message content: {e}")
            return message.text or ""

    async def _process_media_attachments(self, message: TelegramMessage) -> List[Dict[str, Any]]:
        """处理媒体附件"""
        try:
            attachments = []

            if not message.media:
                return attachments

            for media in message.media:
                media_type = media.get("type")
                file_id = media.get("fileId")

                if not file_id:
                    continue

                attachment = {
                    "type": media_type,
                    "file_id": file_id,
                    "file_name": media.get("fileName"),
                    "mime_type": media.get("mimeType"),
                    "size": media.get("size")
                }

                attachments.append(attachment)

            return attachments

        except Exception as e:
            logger.error(f"Error processing media attachments: {e}")
            return []


class MessageFilter:
    """消息过滤器"""

    @staticmethod
    def should_skip_message(message: TelegramMessage, rules: Dict[str, Any]) -> bool:
        """检查消息是否应该被跳过"""
        try:
            # 检查频道过滤
            if rules.get("ignore_self") and message.from_user:
                # TODO: 检查是否是自己发送的消息
                pass

            if rules.get("ignore_bot") and message.from_user:
                # TODO: 检查是否是机器人发送的消息
                pass

            # 检查媒体类型过滤
            if message.media:
                for media in message.media:
                    media_type = media.get("type")
                    if rules.get(f"ignore_{media_type}s"):
                        return True

            # 检查文件过滤
            if rules.get("ignore_documents") and any(
                m.get("type") == "document" for m in message.media
            ):
                return True

            return False

        except Exception as e:
            logger.error(f"Error checking message skip rules: {e}")
            return False


class DiscordToTelegramConverter(MessageConverter):
    """Discord到Telegram转换器"""

    def __init__(self, config: ConversionConfig):
        super().__init__(config)

    async def convert_discord_to_telegram(
        self,
        discord_message: Dict[str, Any],
        mapping: TelegramMapping
    ) -> Optional[Dict[str, Any]]:
        """
        将Discord消息转换为Telegram格式

        Args:
            discord_message: Discord消息数据
            mapping: 映射配置

        Returns:
            Telegram消息格式或None（如果转换失败）
        """
        try:
            # 构建消息内容
            content = self._build_telegram_content(discord_message, mapping)

            # 处理附件
            attachments = self._process_discord_attachments(discord_message)

            # 转换Discord格式到Telegram格式
            telegram_content = self._convert_discord_formatting_to_telegram(content)

            # 检查是否需要追加文本（Telegram特有功能）
            # 优先使用规则级别的设置，如果没有则使用全局设置
            long_message_config = None
            if hasattr(mapping, 'longMessage') and mapping.longMessage and isinstance(mapping.longMessage, dict) and mapping.longMessage.get('enabled'):
                long_message_config = mapping.longMessage
            elif hasattr(self.config, 'telegramLongMessage') and self.config.telegramLongMessage and isinstance(self.config.telegramLongMessage, dict) and self.config.telegramLongMessage.get('enabled'):
                long_message_config = self.config.telegramLongMessage

            if long_message_config:
                threshold = long_message_config.get('threshold', 0)
                append_message = long_message_config.get('appendMessage', '')
                if isinstance(threshold, (int, float)) and threshold > 0 and len(telegram_content) > threshold:
                    telegram_content = telegram_content[:threshold]
                    if append_message:
                        # 将转义的换行符转换回实际换行符，并确保另起一行追加
                        normalized_append = append_message.replace('\\n', '\n')
                        telegram_content += f"\n{normalized_append}"

            # 解析目标频道ID（可能是channel_id或account_id格式）
            try:
                # 如果是纯数字，直接使用
                chat_id = int(mapping.target_channel_id)
            except ValueError:
                # 如果包含非数字字符，尝试提取数字部分或使用默认值
                import re
                numbers = re.findall(r'\d+', mapping.target_channel_id)
                chat_id = int(numbers[0]) if numbers else 0

            # 构建Telegram消息
            watermark_payload = discord_message.get("watermarks")
            if watermark_payload is None:
                primary = discord_message.get("watermark") or getattr(mapping, "watermark", None)
                secondary = discord_message.get("watermarkSecondary") or getattr(mapping, "watermark_secondary", None)
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
                        watermark_payload = merged[0]
                    elif len(merged) > 1:
                        watermark_payload = merged
                    else:
                        watermark_payload = primary
                else:
                    watermark_payload = primary

            telegram_message = {
                "chat_id": chat_id,
                "text": telegram_content,
                "parse_mode": self._determine_parse_mode(telegram_content),
                "reply_to_message_id": discord_message.get("replyToMessageId"),
                "attachments": attachments,
                "watermark": watermark_payload,
                "watermarks": watermark_payload if isinstance(watermark_payload, list) else ([watermark_payload] if watermark_payload else None),
            }

            return telegram_message

        except Exception as e:
            logger.error(f"Failed to convert Discord message to Telegram format: {e}")
            return None

    def _build_telegram_content(self, discord_message: Dict[str, Any], mapping: TelegramMapping) -> str:
        """构建Telegram消息内容"""
        try:
            content_parts = []

            # 添加来源标识 - 使用HTML格式的粗体(更可靠)
            if self.config.show_source_identity:
                author = discord_message.get("author", {})
                display_name = author.get("displayName") or author.get("username", "Unknown")
                # HTML转义显示名称
                display_name = html.escape(display_name)
                content_parts.append(f"<b>{display_name}</b>: ")

            # 获取消息文本
            text = discord_message.get("content", "").strip()
            original_text = text  # 保存原文用于翻译

            # 处理翻译
            if mapping.translate and self.config.enable_translation:
                # TODO: 实现实际的翻译API调用
                # 目前使用占位符,需要集成翻译服务(DeepSeek/OpenAI等)
                translated_text = f"[翻译内容 - 待实现翻译API]"

                # 格式: 原文\n────────\n翻译内容
                text = f"{original_text}\n────────\n{translated_text}"

            # 处理Discord到Telegram格式转换
            text = self._convert_discord_formatting_to_telegram(text)

            # 应用替换规则
            if self.config.replacements:
                for old_text, new_text in self.config.replacements.items():
                    text = text.replace(old_text, new_text)

            # 处理embed内容（简化为文本）
            embeds = discord_message.get("embeds", [])
            if embeds:
                for embed in embeds:
                    if embed.get("description"):
                        text += f"\n{embed['description']}"
                    if embed.get("title"):
                        text += f"\n**{embed['title']}**"
                    if embed.get("url"):
                        text += f"\n{embed['url']}"

            content_parts.append(text)

            return "".join(content_parts).strip()

        except Exception as e:
            logger.error(f"Error building Telegram content: {e}")
            return discord_message.get("content", "")

    def _process_discord_attachments(self, discord_message: Dict[str, Any]) -> List[Dict[str, Any]]:
        """处理Discord附件"""
        try:
            attachments = []

            discord_attachments = discord_message.get("attachments", [])
            for attachment in discord_attachments:
                telegram_attachment = {
                    "type": self._map_discord_attachment_type(attachment),
                    "url": attachment.get("url"),
                    "filename": attachment.get("filename"),
                    "size": attachment.get("size"),
                    "content_type": attachment.get("contentType")
                }
                attachments.append(telegram_attachment)

            return attachments

        except Exception as e:
            logger.error(f"Error processing Discord attachments: {e}")
            return []

    def _map_discord_attachment_type(self, attachment: Dict[str, Any]) -> str:
        """映射Discord附件类型到Telegram类型"""
        content_type = attachment.get("contentType", "").lower()

        # 支持标准 MIME 类型 (image/png) 和简化类型 (image)
        if content_type.startswith("image/") or content_type == "image":
            return "photo"
        elif content_type.startswith("video/") or content_type == "video":
            return "video"
        elif content_type.startswith("audio/") or content_type == "audio":
            return "audio"
        else:
            return "document"

    def _determine_parse_mode(self, content: str) -> Optional[str]:
        """确定Telegram解析模式"""
        # 检查是否包含Markdown语法
        markdown_chars = ["*", "_", "`", "[", "]", "(", ")", "~", "`", ">", "#", "+", "-", "=", "|", "{", "}", ".", "!"]
        has_markdown = any(char in content for char in markdown_chars)

        # 检查是否包含HTML标签
        import re
        has_html = bool(re.search(r'<[^>]+>', content))

        if has_html:
            return "HTML"
        elif has_markdown:
            return "Markdown"
        else:
            return None

    def _convert_discord_formatting_to_telegram(self, content: str) -> str:
        """转换Discord格式到Telegram格式"""
        try:
            # Discord -> Telegram格式映射
            # Discord使用*italic*，Telegram使用_italic_
            # Discord使用**bold**，Telegram使用*bold*
            # Discord使用__underline__，Telegram使用__underline__
            # Discord使用~~strikethrough~~，Telegram使用~strikethrough~
            # Discord使用`code`，Telegram使用`code`（兼容）
            # Discord使用```codeblock```，Telegram使用```codeblock```

            # 注意：这里只是基本转换，复杂的嵌套格式可能需要更复杂的解析
            # Discord的**bold**在Telegram中是*bold*
            content = re.sub(r'\*\*(.*?)\*\*', r'*\1*', content)  # **bold** -> *bold*

            # Discord的*italic*在Telegram中保持*italic*（兼容）
            # Discord的__underline__在Telegram中保持__underline__（兼容）

            # Discord的~~strikethrough~~在Telegram中是~strikethrough~
            content = re.sub(r'~~(.*?)~~', r'~\1~', content)  # ~~strike~~ -> ~strike~

            # 处理代码块
            # Discord的`code`保持不变
            # Discord的```codeblock```保持不变，但可能需要调整

            # 处理链接
            # Discord的[link](url)格式在Telegram中也支持

            # 处理换行（Discord的换行在Telegram中应该保持）
            content = content.replace('\r\n', '\n').replace('\r', '\n')

            return content

        except Exception as e:
            logger.error(f"Failed to convert Discord formatting: {e}")
            return content

    def _convert_telegram_formatting_to_discord(self, content: str) -> str:
        """转换Telegram格式到Discord格式"""
        try:
            # Telegram -> Discord格式映射
            # 基本保持兼容，但可以根据需要调整

            # Telegram的*bold*在Discord中是**bold**
            content = re.sub(r'\*(.*?)\*', r'**\1**', content)  # *bold* -> **bold**

            # Telegram的_italic_在Discord中是*italic*（兼容）
            # Telegram的__underline__在Discord中保持__underline__（兼容）

            # Telegram的~strikethrough~在Discord中是~~strikethrough~~
            content = re.sub(r'~(.*?)~', r'~~\1~~', content)  # ~strike~ -> ~~strike~~

            # Telegram的`code`和```codeblock```在Discord中兼容

            # 处理HTML标签（转换为Discord格式）
            # 简单的HTML转换
            content = re.sub(r'<b>(.*?)</b>', r'**\1**', content, flags=re.IGNORECASE)  # <b> -> **
            content = re.sub(r'<i>(.*?)</i>', r'*\1*', content, flags=re.IGNORECASE)    # <i> -> *
            content = re.sub(r'<u>(.*?)</u>', r'__\1__', content, flags=re.IGNORECASE)  # <u> -> __
            content = re.sub(r'<s>(.*?)</s>', r'~~\1~~', content, flags=re.IGNORECASE)  # <s> -> ~~
            content = re.sub(r'<code>(.*?)</code>', r'`\1`', content, flags=re.IGNORECASE)  # <code> -> `
            content = re.sub(r'<pre>(.*?)</pre>', r'```\1```', content, flags=re.IGNORECASE)  # <pre> -> ```

            return content

        except Exception as e:
            logger.error(f"Failed to convert Telegram formatting: {e}")
            return content


class TelegramToDiscordConverter:
    """Telegram到Discord转换器"""

    def __init__(self, config: ConversionConfig):
        self.message_converter = MessageConverter(config)
        self.message_filter = MessageFilter()

    async def convert_and_filter(
        self,
        telegram_message: TelegramMessage,
        mapping: TelegramMapping,
        filter_rules: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """
        转换并过滤Telegram消息为Discord格式

        Args:
            telegram_message: Telegram消息
            mapping: 映射配置
            filter_rules: 过滤规则

        Returns:
            Discord消息格式或None（如果被过滤）
        """
        try:
            # 应用通用过滤规则
            if filter_rules and self.message_filter.should_skip_message(telegram_message, filter_rules):
                return None

            # 转换为Discord格式
            return await self.message_converter.convert_telegram_to_discord(telegram_message, mapping)

        except Exception as e:
            logger.error(f"Error in convert_and_filter: {e}")
            return None
