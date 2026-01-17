"""
媒体文件处理器
负责下载、处理和上传媒体文件到Telegram
"""

import aiohttp
import asyncio
import tempfile
import os
from pathlib import Path
from typing import Dict, Optional, Any, Tuple
from loguru import logger


class MediaHandler:
    """媒体文件处理器"""

    def __init__(self, max_file_size: int = 50 * 1024 * 1024):  # 50MB默认限制
        """
        初始化媒体处理器

        Args:
            max_file_size: 最大文件大小（字节）
        """
        self.max_file_size = max_file_size
        self.temp_dir = Path(tempfile.gettempdir()) / "telegram_bridge_media"
        self.temp_dir.mkdir(exist_ok=True)

    async def download_media(self, url: str, filename: Optional[str] = None) -> Optional[Path]:
        """
        下载媒体文件

        Args:
            url: 文件URL
            filename: 指定文件名

        Returns:
            下载的文件路径，如果失败返回None
        """
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as response:
                    if response.status != 200:
                        logger.error(f"Failed to download media: HTTP {response.status}")
                        return None

                    # 检查文件大小
                    content_length = response.headers.get('Content-Length')
                    if content_length and int(content_length) > self.max_file_size:
                        logger.error(f"File too large: {content_length} bytes")
                        return None

                    # 生成文件名
                    if not filename:
                        content_disposition = response.headers.get('Content-Disposition', '')
                        if 'filename=' in content_disposition:
                            filename = content_disposition.split('filename=')[-1].strip('";')
                        else:
                            # 从URL提取文件名
                            filename = url.split('/')[-1].split('?')[0]
                            if not filename:
                                filename = f"media_{hash(url) % 10000}"

                    # 创建临时文件
                    file_path = self.temp_dir / filename

                    # 下载文件
                    downloaded_size = 0
                    with open(file_path, 'wb') as f:
                        async for chunk in response.content.iter_chunked(8192):
                            if downloaded_size + len(chunk) > self.max_file_size:
                                logger.error(f"File too large during download: {downloaded_size + len(chunk)} bytes")
                                file_path.unlink(missing_ok=True)
                                return None

                            f.write(chunk)
                            downloaded_size += len(chunk)

                    logger.info(f"Downloaded media file: {file_path} ({downloaded_size} bytes)")
                    return file_path

        except Exception as e:
            logger.error(f"Failed to download media from {url}: {e}")
            return None

    async def upload_to_telegram(
        self,
        client_or_bot,
        chat_id: int,
        media_path: Path,
        media_type: str,
        caption: str = "",
        reply_to_message_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        上传媒体文件到Telegram

        Args:
            client_or_bot: Telegram客户端或机器人实例
            chat_id: 聊天ID
            media_path: 媒体文件路径
            media_type: 媒体类型 ('photo', 'video', 'audio', 'document')
            caption: 媒体描述
            reply_to_message_id: 回复消息ID

        Returns:
            发送结果
        """
        try:
            if not media_path.exists():
                return {
                    "success": False,
                    "error": "FILE_NOT_FOUND",
                    "message": f"Media file not found: {media_path}"
                }

            # 检查文件大小
            file_size = media_path.stat().st_size
            if file_size > self.max_file_size:
                return {
                    "success": False,
                    "error": "FILE_TOO_LARGE",
                    "message": f"File size {file_size} exceeds limit {self.max_file_size}"
                }

            # 根据媒体类型发送
            if media_type == "photo":
                result = await client_or_bot.send_file(
                    chat_id,
                    media_path,
                    caption=caption if caption else None,
                    reply_to=reply_to_message_id
                )
            elif media_type == "video":
                result = await client_or_bot.send_file(
                    chat_id,
                    media_path,
                    caption=caption if caption else None,
                    reply_to=reply_to_message_id,
                    video=True
                )
            elif media_type == "audio":
                result = await client_or_bot.send_file(
                    chat_id,
                    media_path,
                    caption=caption if caption else None,
                    reply_to=reply_to_message_id,
                    audio=True
                )
            else:  # document 或其他
                result = await client_or_bot.send_file(
                    chat_id,
                    media_path,
                    caption=caption if caption else None,
                    reply_to=reply_to_message_id
                )

            # 清理临时文件
            try:
                media_path.unlink(missing_ok=True)
            except:
                pass

            return {
                "success": True,
                "messageId": result.id,
                "fileId": getattr(result.media, 'id', None) if hasattr(result, 'media') else None
            }

        except Exception as e:
            # 清理临时文件
            try:
                media_path.unlink(missing_ok=True)
            except:
                pass

            logger.error(f"Failed to upload media to Telegram: {e}")
            return {
                "success": False,
                "error": "UPLOAD_FAILED",
                "message": str(e)
            }

    async def process_discord_attachment(
        self,
        attachment: Dict[str, Any]
    ) -> Optional[Tuple[Path, str]]:
        """
        处理Discord附件

        Args:
            attachment: Discord附件信息

        Returns:
            (文件路径, 媒体类型)元组，如果失败返回None
        """
        try:
            url = attachment.get("url")
            if not url:
                return None

            # 映射Discord媒体类型到Telegram类型
            content_type = attachment.get("contentType", "").lower()
            if content_type.startswith("image/"):
                media_type = "photo"
            elif content_type.startswith("video/"):
                media_type = "video"
            elif content_type.startswith("audio/"):
                media_type = "audio"
            else:
                media_type = "document"

            # 下载文件
            filename = attachment.get("filename", f"attachment_{hash(url) % 10000}")
            file_path = await self.download_media(url, filename)

            return (file_path, media_type) if file_path else None

        except Exception as e:
            logger.error(f"Failed to process Discord attachment: {e}")
            return None

    def cleanup_temp_files(self, max_age_hours: int = 24):
        """清理临时文件"""
        try:
            import time
            current_time = time.time()

            for file_path in self.temp_dir.glob("*"):
                if file_path.is_file():
                    # 检查文件年龄
                    file_age_hours = (current_time - file_path.stat().st_mtime) / 3600
                    if file_age_hours > max_age_hours:
                        try:
                            file_path.unlink()
                            logger.debug(f"Cleaned up old temp file: {file_path}")
                        except Exception as e:
                            logger.error(f"Failed to cleanup temp file {file_path}: {e}")

        except Exception as e:
            logger.error(f"Failed to cleanup temp files: {e}")

    def __del__(self):
        """析构函数，确保清理临时文件"""
        try:
            import shutil
            if self.temp_dir.exists():
                shutil.rmtree(self.temp_dir, ignore_errors=True)
        except:
            pass
