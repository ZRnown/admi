#!/usr/bin/env python3
"""
Session管理器集成测试
"""

import pytest
import asyncio
import tempfile
import os
from pathlib import Path
from telegram_bridge.session import SessionManager


def test_default_session_dir_uses_env_override(monkeypatch, tmp_path):
    """默认Session目录应允许通过环境变量覆写"""
    monkeypatch.setenv("TELEGRAM_SESSIONS_DIR", str(tmp_path))

    session_mgr = SessionManager()

    assert session_mgr.sessions_dir == tmp_path


@pytest.mark.asyncio
class TestSessionManager:
    """Session管理器测试"""

    async def setup_method(self):
        """测试前准备"""
        self.temp_dir = tempfile.mkdtemp()
        self.session_mgr = SessionManager(self.temp_dir)

    async def teardown_method(self):
        """测试后清理"""
        # 清理临时文件
        import shutil
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    async def test_save_and_load_session_string(self):
        """测试session字符串保存和加载"""
        account_id = "test_account_123"
        session_string = "test_session_string_data_abcdef123456"

        # 保存session字符串
        success = await self.session_mgr.save_session_string(account_id, session_string)
        assert success is True

        # 验证文件已创建
        session_file = self.session_mgr.get_session_path(account_id).with_suffix('.session.enc')
        assert session_file.exists()

        # 加载session字符串
        loaded_string = await self.session_mgr.load_session_string(account_id)
        assert loaded_string == session_string

    async def test_delete_session(self):
        """测试session删除"""
        account_id = "test_account_delete"
        session_string = "test_session_to_delete"

        # 保存session
        await self.session_mgr.save_session_string(account_id, session_string)

        # 验证存在
        loaded = await self.session_mgr.load_session_string(account_id)
        assert loaded == session_string

        # 删除session
        success = await self.session_mgr.delete_session(account_id)
        assert success is True

        # 验证已删除
        loaded = await self.session_mgr.load_session_string(account_id)
        assert loaded is None

    async def test_backup_session(self):
        """测试session备份"""
        account_id = "test_account_backup"
        session_string = "test_session_backup_data"

        # 先保存session字符串
        await self.session_mgr.save_session_string(account_id, session_string)

        # 备份session
        success = await self.session_mgr.backup_session(account_id)
        assert success is True

        # 验证备份文件存在
        session_file = self.session_mgr.get_session_path(account_id).with_suffix('.session.enc')
        backup_files = list(session_file.parent.glob(f"{account_id}.session.enc.backup.*"))
        assert len(backup_files) > 0

    async def test_list_sessions(self):
        """测试session列表"""
        # 创建多个session
        accounts = [
            ("account1", "session1_data"),
            ("account2", "session2_data"),
            ("account3", "session3_data")
        ]

        for account_id, session_string in accounts:
            await self.session_mgr.save_session_string(account_id, session_string)

        # 获取session列表
        sessions = await self.session_mgr.list_sessions()

        # 验证所有session都被列出
        for account_id, _ in accounts:
            assert account_id in sessions
            assert sessions[account_id]["type"] == "encrypted_string"

    async def test_session_exists(self):
        """测试session存在性检查"""
        account_id = "test_exists"

        # 初始状态不存在
        assert not self.session_mgr.session_exists(account_id)

        # 保存后存在
        await self.session_mgr.save_session_string(account_id, "test_data")
        assert self.session_mgr.session_exists(account_id)

        # 删除后不存在
        await self.session_mgr.delete_session(account_id)
        assert not self.session_mgr.session_exists(account_id)

    async def test_file_permissions(self):
        """测试文件权限设置"""
        account_id = "test_permissions"
        session_string = "test_permissions_data"

        # 保存session
        await self.session_mgr.save_session_string(account_id, session_string)

        # 检查文件权限（应该设置为600）
        session_file = self.session_mgr.get_session_path(account_id).with_suffix('.session.enc')
        file_stat = session_file.stat()

        # 在Unix系统上检查权限
        import stat
        expected_permissions = stat.S_IRUSR | stat.S_IWUSR  # 0o600
        actual_permissions = file_stat.st_mode & 0o777
        assert actual_permissions == expected_permissions

    async def test_corrupted_file_handling(self):
        """测试损坏文件处理"""
        account_id = "test_corrupted"

        # 创建损坏的加密文件
        session_file = self.session_mgr.get_session_path(account_id).with_suffix('.session.enc')
        session_file.write_text("corrupted_data")

        # 尝试加载应该失败但不崩溃
        loaded = await self.session_mgr.load_session_string(account_id)
        assert loaded is None  # 应该返回None而不是抛出异常

    async def test_concurrent_access(self):
        """测试并发访问"""
        account_id = "test_concurrent"
        session_string = "concurrent_test_data"

        # 并发保存
        tasks = []
        for i in range(5):
            task = self.session_mgr.save_session_string(f"{account_id}_{i}", f"{session_string}_{i}")
            tasks.append(task)

        results = await asyncio.gather(*tasks)

        # 所有保存都应该成功
        assert all(results)

        # 并发加载
        load_tasks = []
        for i in range(5):
            task = self.session_mgr.load_session_string(f"{account_id}_{i}")
            load_tasks.append(task)

        load_results = await asyncio.gather(*load_tasks)

        # 验证所有数据都正确加载
        for i, result in enumerate(load_results):
            assert result == f"{session_string}_{i}"


if __name__ == "__main__":
    # 运行测试
    pytest.main([__file__, "-v"])
