"""
媒体文件处理器
负责下载、处理和上传媒体文件到Telegram
"""

import aiohttp
import asyncio
import tempfile
import os
import hashlib
import urllib.request
from pathlib import Path
from typing import Dict, Optional, Any, Tuple
from loguru import logger
from PIL import Image, ImageDraw, ImageFont

from .wavespeed_watermark_remover import remove_watermark_from_image_url

AUTO_FONT_DOWNLOAD = os.getenv("WATERMARK_AUTO_FONT_DOWNLOAD", "1") != "0"
FONT_CACHE_DIR = Path(os.getcwd()) / ".data" / "watermark_fonts"
DEFAULT_CJK_FONT_URLS = [
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%BE%AE%E8%BD%AF%E9%9B%85%E9%BB%91.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%BE%AE%E8%BD%AF%E9%9B%85%E9%BB%91%E7%B2%97%E4%BD%93.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%8D%8E%E6%96%87%E7%BB%86%E9%BB%91.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%8D%8E%E6%96%87%E4%B8%AD%E5%AE%8B.ttf",
    "https://raw.githubusercontent.com/chengda/popular-fonts/master/%E5%8D%8E%E6%96%87%E6%A5%B7%E4%BD%93.ttf",
]
DEFAULT_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.otf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]

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
        self.default_font_path: Optional[str] = None
        self._http_session: Optional[aiohttp.ClientSession] = None
        self._ensure_default_font()

    def _get_http_session(self) -> aiohttp.ClientSession:
        if self._http_session and not self._http_session.closed:
            return self._http_session
        timeout = aiohttp.ClientTimeout(total=30, connect=8)
        connector = aiohttp.TCPConnector(limit=16, ttl_dns_cache=300, keepalive_timeout=30)
        self._http_session = aiohttp.ClientSession(timeout=timeout, connector=connector)
        return self._http_session

    async def close(self):
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()
        self._http_session = None

    def _ensure_default_font(self):
        try:
            FONT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        self.default_font_path = self._resolve_default_font_path()
        if self.default_font_path:
            logger.info(f"Watermark font ready: {self.default_font_path}")
        else:
            logger.warning("Watermark font not found; Chinese text watermark may show as squares")

    def _resolve_default_font_path(self) -> Optional[str]:
        if AUTO_FONT_DOWNLOAD:
            if DEFAULT_CJK_FONT_URLS:
                primary = DEFAULT_CJK_FONT_URLS[0]
                downloaded = self._download_font(primary)
                if downloaded:
                    return downloaded
        for candidate in DEFAULT_FONT_CANDIDATES:
            if candidate and os.path.exists(candidate):
                return candidate
        if AUTO_FONT_DOWNLOAD:
            for url in DEFAULT_CJK_FONT_URLS[1:]:
                downloaded = self._download_font(url)
                if downloaded:
                    return downloaded
        return None

    def _is_font_data(self, data: bytes) -> bool:
        if not data or len(data) < 1024:
            return False
        magic = data[:4]
        if magic in [b"OTTO", b"ttcf", b"true", b"typ1"]:
            return True
        if data[:4] == b"\x00\x01\x00\x00":
            return True
        head = data[:32].decode("utf-8", errors="ignore").lower()
        if "<html" in head or "<!doctype" in head:
            return False
        return False

    def _download_font(self, url: str) -> Optional[str]:
        if not AUTO_FONT_DOWNLOAD or not url:
            return None
        try:
            hash_key = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
            ext = os.path.splitext(url)[-1] or ".otf"
            target = FONT_CACHE_DIR / f"{hash_key}{ext}"
            if target.exists():
                return str(target)
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = resp.read()
            if not self._is_font_data(data):
                logger.warning(f"Invalid font data downloaded, skip: {url}")
                return None
            with open(target, "wb") as f:
                f.write(data)
            logger.info(f"Downloaded watermark font: {url} -> {target}")
            return str(target)
        except Exception as e:
            logger.warning(f"Failed to download font: {url} err={e}")
            return None

    def _resolve_font_path(self, font_path: Optional[str]) -> Optional[str]:
        if not font_path:
            return None
        raw = str(font_path).strip()
        if not raw:
            return None
        if raw.startswith("file://"):
            raw = raw[7:]
        if raw.startswith("http://") or raw.startswith("https://"):
            return self._download_font(raw)
        if os.path.exists(raw):
            return raw
        return None

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
            session = self._get_http_session()
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
        chat_id: Any,
        media_path: Path,
        media_type: str,
        caption: str = "",
        reply_to_message_id: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        上传媒体文件到Telegram

        Args:
            client_or_bot: Telegram客户端或机器人实例
            chat_id: 聊天ID或实体对象
            media_path: 媒体文件路径
            media_type: 媒体类型 ('photo', 'video', 'audio', 'document')
            caption: 媒体描述
            reply_to_message_id: 回复消息ID

        Returns:
            发送结果
        """
        try:
            logger.info(f"upload_to_telegram called: media_path={media_path}, media_type={media_type}")
            # 检查必要参数
            if client_or_bot is None:
                return {
                    "success": False,
                    "error": "CLIENT_NOT_PROVIDED",
                    "message": "Telegram client or bot is None"
                }

            if chat_id is None:
                return {
                    "success": False,
                    "error": "CHAT_ID_NOT_PROVIDED",
                    "message": "Chat ID is None"
                }

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
                # 将 PNG 转换为 JPEG 以避免 Telethon 的 has_transparency_data 兼容性问题
                send_path = media_path
                logger.info(f"Preparing to send photo: {media_path}, suffix={media_path.suffix}")
                if media_path.suffix.lower() == '.png':
                    try:
                        from PIL import Image
                        logger.info(f"Converting PNG to JPEG: {media_path}")
                        img = Image.open(media_path)
                        jpeg_path = media_path.with_suffix('.jpg')
                        # 转换为 RGB（移除透明通道）
                        if img.mode in ('RGBA', 'LA', 'P'):
                            background = Image.new('RGB', img.size, (255, 255, 255))
                            if img.mode == 'P':
                                img = img.convert('RGBA')
                            background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                            img = background
                        else:
                            img = img.convert('RGB')
                        img.save(jpeg_path, 'JPEG', quality=95)
                        img.close()
                        send_path = jpeg_path
                        logger.info(f"Successfully converted PNG to JPEG: {jpeg_path}")
                    except Exception as e:
                        logger.warning(f"Failed to convert PNG to JPEG: {e}, using original")

                logger.info(f"Sending photo via send_file: {send_path}")
                result = await client_or_bot.send_file(
                    chat_id,
                    str(send_path),  # 确保传递字符串路径
                    caption=caption if caption else None,
                    reply_to=reply_to_message_id
                )

                # 清理转换后的临时文件
                if send_path != media_path:
                    try:
                        send_path.unlink(missing_ok=True)
                    except:
                        pass
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
        attachment: Dict[str, Any],
        watermark: Optional[Any] = None
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
            local_path = attachment.get("localPath") or attachment.get("path")
            if not url and not local_path:
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

            if attachment.get("isImage"):
                media_type = "photo"
            if attachment.get("isVideo"):
                media_type = "video"

            # 根据文件扩展名判断媒体类型（作为后备）
            filename = attachment.get("filename", "")
            if filename:
                ext = filename.lower().split(".")[-1] if "." in filename else ""
                if ext in ("png", "jpg", "jpeg", "gif", "webp", "bmp"):
                    media_type = "photo"
                elif ext in ("mp4", "mov", "webm", "mkv", "avi"):
                    media_type = "video"
                elif ext in ("mp3", "wav", "ogg", "flac", "m4a"):
                    media_type = "audio"

            logger.info(f"process_discord_attachment: contentType={content_type}, isImage={attachment.get('isImage')}, filename={filename}, media_type={media_type}")

            watermark_removal = attachment.get("watermarkRemoval")
            watermark_removal_state = attachment.get("watermarkRemovalState") or {}
            removal_attempted = bool(watermark_removal_state.get("attempted"))
            removal_failed = bool(watermark_removal_state.get("failed"))
            if media_type == "photo" and url and watermark_removal and not watermark_removal_state:
                try:
                    removal_attempted = True
                    url = await remove_watermark_from_image_url(url, watermark_removal, self._get_http_session())
                    logger.info(f"Watermark removed via WaveSpeed: {filename or url}")
                except Exception as removal_error:
                    removal_failed = True
                    logger.error(f"Failed to remove watermark, fallback original image: {removal_error}")

            # 下载文件
            filename = attachment.get("filename", f"attachment_{hash(url) % 10000}")
            if local_path:
                file_path = Path(str(local_path))
            else:
                file_path = await self.download_media(url, filename)

            if file_path and media_type == "photo" and not (removal_attempted and removal_failed):
                await self._apply_watermark(file_path, watermark)
            elif file_path and media_type == "photo" and removal_attempted and removal_failed and watermark:
                logger.info("Skip adding new watermark because watermark removal failed")

            return (file_path, media_type) if file_path else None

        except Exception as e:
            logger.error(f"Failed to process Discord attachment: {e}")
            return None

    def _resolve_watermark_position(
        self,
        base_width: int,
        base_height: int,
        mark_width: int,
        mark_height: int,
        position: Optional[str],
        margin: int,
    ) -> Tuple[int, int]:
        pos = position or "bottom-right"
        x = margin
        y = margin
        if pos == "top-left":
            x = margin
            y = margin
        elif pos == "top":
            x = (base_width - mark_width) // 2
            y = margin
        elif pos == "top-right":
            x = base_width - mark_width - margin
            y = margin
        elif pos == "bottom-left":
            x = margin
            y = base_height - mark_height - margin
        elif pos == "bottom":
            x = (base_width - mark_width) // 2
            y = base_height - mark_height - margin
        elif pos == "center":
            x = (base_width - mark_width) // 2
            y = (base_height - mark_height) // 2
        else:
            x = base_width - mark_width - margin
            y = base_height - mark_height - margin
        return max(0, x), max(0, y)

    def _parse_hex_color(self, value: Optional[str]) -> Tuple[int, int, int]:
        if not value:
            return (255, 255, 255)
        raw = value.strip().lstrip("#")
        if len(raw) != 6:
            return (255, 255, 255)
        try:
            r = int(raw[0:2], 16)
            g = int(raw[2:4], 16)
            b = int(raw[4:6], 16)
            return (r, g, b)
        except Exception:
            return (255, 255, 255)

    def _load_font(self, size: int, font_path: Optional[str] = None) -> ImageFont.ImageFont:
        resolved = self._resolve_font_path(font_path)
        if resolved:
            try:
                return ImageFont.truetype(resolved, size=size)
            except Exception:
                pass
        if self.default_font_path:
            try:
                return ImageFont.truetype(self.default_font_path, size=size)
            except Exception:
                pass
        try:
            return ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size=size)
        except Exception:
            try:
                return ImageFont.truetype("DejaVuSans.ttf", size=size)
            except Exception:
                return ImageFont.load_default()

    async def _load_watermark_image(self, source: str) -> Optional[Image.Image]:
        if not source:
            return None
        try:
            if source.startswith("http://") or source.startswith("https://"):
                filename = f"watermark_{hash(source) % 100000}.png"
                downloaded = await self.download_media(source, filename)
                if not downloaded:
                    return None
                try:
                    return Image.open(downloaded).convert("RGBA")
                finally:
                    try:
                        downloaded.unlink(missing_ok=True)
                    except Exception:
                        pass
            if source.startswith("file://"):
                source = source[7:]
            if not os.path.exists(source):
                return None
            return Image.open(source).convert("RGBA")
        except Exception as e:
            logger.error(f"Failed to load watermark image: {e}")
            return None

    async def _apply_watermark(self, file_path: Path, watermark: Optional[Any]):
        if not watermark:
            logger.debug(f"No watermark config provided for {file_path}")
            return
        if isinstance(watermark, list):
            logger.info(f"Applying {len(watermark)} watermarks to {file_path}")
            for item in watermark:
                await self._apply_watermark(file_path, item)
            return
        if not isinstance(watermark, dict):
            logger.warning(f"Invalid watermark config type: {type(watermark)}")
            return
        if watermark.get("enabled") is False:
            logger.debug(f"Watermark disabled in config")
            return
        logger.info(f"Applying watermark to {file_path}: {watermark}")
        mode = str(watermark.get("mode") or "").strip().lower()
        pattern = str(watermark.get("pattern") or "").strip().lower()
        tile_gap = int(watermark.get("tileGap") or 40)
        tile_gap = max(0, tile_gap)
        allow_text = mode != "image"
        allow_image = mode != "text"
        text = str(watermark.get("text") or "").strip()
        image_url = str(watermark.get("imageUrl") or "").strip()
        if (not allow_text or not text) and (not allow_image or not image_url):
            return

        try:
            base = Image.open(file_path)
            base_format = (base.format or "PNG").upper()
            base_image = base.convert("RGBA")
            overlay = Image.new("RGBA", base_image.size, (0, 0, 0, 0))
            draw = ImageDraw.Draw(overlay)

            margin = int(watermark.get("margin") or 8)
            margin = max(0, margin)
            position = watermark.get("position")

            if image_url and allow_image:
                wm_image = await self._load_watermark_image(image_url)
                if wm_image:
                    scale = int(watermark.get("imageScale") or 20)
                    scale = max(1, min(100, scale))
                    target_width = max(1, int(base_image.width * (scale / 100)))
                    ratio = target_width / wm_image.width
                    target_height = max(1, int(wm_image.height * ratio))
                    wm_image = wm_image.resize((target_width, target_height), Image.LANCZOS)
                    opacity = int(watermark.get("imageOpacity") or 60)
                    opacity = max(0, min(100, opacity))
                    if opacity < 100:
                        alpha = wm_image.split()[3]
                        alpha = alpha.point(lambda p: int(p * (opacity / 100)))
                        wm_image.putalpha(alpha)
                    if pattern == "tile":
                        step_x = max(1, wm_image.width + tile_gap)
                        step_y = max(1, wm_image.height + tile_gap)
                        for y in range(0, base_image.height, step_y):
                            for x in range(0, base_image.width, step_x):
                                overlay.paste(wm_image, (x, y), wm_image)
                    else:
                        x, y = self._resolve_watermark_position(
                            base_image.width, base_image.height, wm_image.width, wm_image.height, position, margin
                        )
                        overlay.paste(wm_image, (x, y), wm_image)

            if text and allow_text:
                size = int(watermark.get("textSize") or 16)
                size = max(8, size)
                font = self._load_font(size, watermark.get("fontPath"))
                text_color = self._parse_hex_color(watermark.get("textColor"))
                opacity = int(watermark.get("textOpacity") or 60)
                opacity = max(0, min(100, opacity))
                fill = (*text_color, int(255 * (opacity / 100)))
                text_box = draw.textbbox((0, 0), text, font=font)
                text_width = text_box[2] - text_box[0]
                text_height = text_box[3] - text_box[1]
                if pattern == "tile":
                    step_x = max(1, text_width + tile_gap)
                    step_y = max(1, text_height + tile_gap)
                    for y in range(0, base_image.height, step_y):
                        for x in range(0, base_image.width, step_x):
                            draw.text((x, y), text, font=font, fill=fill)
                else:
                    x, y = self._resolve_watermark_position(
                        base_image.width, base_image.height, text_width, text_height, position, margin
                    )
                    draw.text((x, y), text, font=font, fill=fill)

            merged = Image.alpha_composite(base_image, overlay)
            if base_format in ["JPEG", "JPG"]:
                merged = merged.convert("RGB")
            merged.save(file_path, format=base_format)
        except Exception as e:
            logger.error(f"Failed to apply watermark: {e}")
            return

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
