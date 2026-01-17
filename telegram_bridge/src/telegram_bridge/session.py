"""
Session管理器
负责Telegram session文件和字符串的安全存储和管理
"""

import os
import json
import base64
from pathlib import Path
from typing import Optional, Dict, Any
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from loguru import logger
import aiofiles


class SessionManager:
    """Session管理器"""

    def __init__(self, sessions_dir: str = "~/.telegram-sessions"):
        self.sessions_dir = Path(sessions_dir).expanduser()
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self._cipher = None

    def _get_cipher(self) -> Fernet:
        """获取加密器（懒加载）"""
        if self._cipher is None:
            # 使用固定密钥进行加密（生产环境应该使用更安全的密钥管理）
            # Fernet需要32字节的密钥，这里我们生成正确的长度
            key_material = b'telegram-bridge-encryption-key-2024'
            key = base64.urlsafe_b64encode(key_material.ljust(32, b'\0')[:32])
            self._cipher = Fernet(key)
        return self._cipher

    def get_session_path(self, account_id: str) -> Path:
        """获取session文件路径"""
        return self.sessions_dir / f"{account_id}.session"

    async def save_session_string(self, account_id: str, session_string: str) -> bool:
        """保存session字符串（加密存储）"""
        try:
            # 加密session字符串
            cipher = self._get_cipher()
            encrypted_data = cipher.encrypt(session_string.encode())

            # 保存到文件
            session_file = self.get_session_path(account_id).with_suffix('.session.enc')
            async with aiofiles.open(session_file, 'wb') as f:
                await f.write(encrypted_data)

            # 设置文件权限为600
            os.chmod(session_file, 0o600)

            logger.info(f"Session string saved for account {account_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to save session string for account {account_id}: {e}")
            return False

    async def load_session_string(self, account_id: str) -> Optional[str]:
        """加载session字符串"""
        try:
            session_file = self.get_session_path(account_id).with_suffix('.session.enc')

            if not session_file.exists():
                return None

            # 读取并解密
            cipher = self._get_cipher()
            async with aiofiles.open(session_file, 'rb') as f:
                encrypted_data = await f.read()

            decrypted_data = cipher.decrypt(encrypted_data)
            session_string = decrypted_data.decode()

            logger.info(f"Session string loaded for account {account_id}")
            return session_string

        except Exception as e:
            logger.error(f"Failed to load session string for account {account_id}: {e}")
            return None

    async def delete_session(self, account_id: str) -> bool:
        """删除session文件"""
        try:
            session_file = self.get_session_path(account_id)
            enc_session_file = session_file.with_suffix('.session.enc')

            # 删除普通session文件
            if session_file.exists():
                session_file.unlink()
                logger.info(f"Session file deleted for account {account_id}")

            # 删除加密session文件
            if enc_session_file.exists():
                enc_session_file.unlink()
                logger.info(f"Encrypted session file deleted for account {account_id}")

            return True

        except Exception as e:
            logger.error(f"Failed to delete session for account {account_id}: {e}")
            return False

    async def backup_session(self, account_id: str) -> bool:
        """备份session文件"""
        try:
            session_file = self.get_session_path(account_id)
            if not session_file.exists():
                return False

            # 创建备份文件名
            backup_file = session_file.with_suffix(f'.session.backup.{int(__import__("time").time())}')

            # 复制文件
            async with aiofiles.open(session_file, 'rb') as src:
                async with aiofiles.open(backup_file, 'wb') as dst:
                    await dst.write(await src.read())

            logger.info(f"Session backed up for account {account_id}: {backup_file}")
            return True

        except Exception as e:
            logger.error(f"Failed to backup session for account {account_id}: {e}")
            return False

    async def list_sessions(self) -> Dict[str, Dict[str, Any]]:
        """列出所有session"""
        sessions = {}

        try:
            for session_file in self.sessions_dir.glob("*.session*"):
                if session_file.suffix == '.session':
                    account_id = session_file.stem
                    sessions[account_id] = {
                        "type": "file",
                        "path": str(session_file),
                        "size": session_file.stat().st_size,
                        "modified": session_file.stat().st_mtime
                    }
                elif session_file.suffix == '.enc':
                    account_id = session_file.stem.replace('.session', '')
                    sessions[account_id] = {
                        "type": "encrypted_string",
                        "path": str(session_file),
                        "size": session_file.stat().st_size,
                        "modified": session_file.stat().st_mtime
                    }

        except Exception as e:
            logger.error(f"Failed to list sessions: {e}")

        return sessions

    def session_exists(self, account_id: str) -> bool:
        """检查session是否存在"""
        session_file = self.get_session_path(account_id)
        enc_session_file = session_file.with_suffix('.session.enc')
        return session_file.exists() or enc_session_file.exists()

    async def import_session_from_file(self, account_id: str, file_path: str) -> bool:
        """从文件导入session字符串"""
        try:
            file_path = Path(file_path)
            if not file_path.exists():
                logger.error(f"Session file not found: {file_path}")
                return False

            # 读取session文件内容
            async with aiofiles.open(file_path, 'r', encoding='utf-8') as f:
                session_string = await f.read()

            # 保存session字符串
            return await self.save_session_string(account_id, session_string.strip())

        except Exception as e:
            logger.error(f"Failed to import session from file {file_path}: {e}")
            return False

    async def export_session_to_file(self, account_id: str, file_path: str) -> bool:
        """导出session字符串到文件"""
        try:
            # 加载session字符串
            session_string = await self.load_session_string(account_id)
            if not session_string:
                logger.error(f"No session found for account {account_id}")
                return False

            # 写入到文件
            file_path = Path(file_path)
            async with aiofiles.open(file_path, 'w', encoding='utf-8') as f:
                await f.write(session_string)

            # 设置文件权限
            os.chmod(file_path, 0o600)

            logger.info(f"Session exported to file: {file_path}")
            return True

        except Exception as e:
            logger.error(f"Failed to export session to file {file_path}: {e}")
            return False

    async def convert_session_file_to_string(self, account_id: str) -> Optional[str]:
        """将session文件转换为字符串"""
        try:
            session_file = self.get_session_path(account_id)
            if not session_file.exists():
                return None

            # 读取session文件
            async with aiofiles.open(session_file, 'rb') as f:
                session_data = await f.read()

            # 转换为base64字符串
            session_string = base64.b64encode(session_data).decode('utf-8')
            return session_string

        except Exception as e:
            logger.error(f"Failed to convert session file to string for {account_id}: {e}")
            return None

    async def convert_session_string_to_file(self, account_id: str, session_string: str) -> bool:
        """将session字符串转换为文件"""
        try:
            # 解码base64字符串
            session_data = base64.b64decode(session_string)

            # 保存到session文件
            session_file = self.get_session_path(account_id)
            async with aiofiles.open(session_file, 'wb') as f:
                await f.write(session_data)

            # 设置文件权限
            os.chmod(session_file, 0o600)

            logger.info(f"Session file created from string for account {account_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to convert session string to file for {account_id}: {e}")
            return False

    async def migrate_legacy_sessions(self) -> Dict[str, bool]:
        """迁移旧版session文件到加密存储"""
        results = {}

        try:
            for session_file in self.sessions_dir.glob("*.session"):
                if session_file.suffix == '.session' and not session_file.name.endswith('.enc'):
                    account_id = session_file.stem

                    # 转换为字符串
                    session_string = await self.convert_session_file_to_string(account_id)
                    if session_string:
                        # 保存为加密字符串
                        success = await self.save_session_string(account_id, session_string)
                        if success:
                            # 备份原文件
                            backup_file = session_file.with_suffix('.session.backup')
                            async with aiofiles.open(session_file, 'rb') as src:
                                async with aiofiles.open(backup_file, 'wb') as dst:
                                    await dst.write(await src.read())

                            # 删除原文件
                            session_file.unlink()
                            logger.info(f"Migrated session for account {account_id}")

                        results[account_id] = success
                    else:
                        results[account_id] = False

        except Exception as e:
            logger.error(f"Failed to migrate legacy sessions: {e}")

        return results