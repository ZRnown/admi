#!/usr/bin/env python3
"""
基础功能测试脚本
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from telegram_bridge.types import TelegramAccount, AccountType, ConnectionStatus
from telegram_bridge.session import SessionManager
import asyncio


async def test_session_manager():
    """测试Session管理器"""
    print("Testing SessionManager...")

    session_mgr = SessionManager("./test_sessions")

    # 测试session字符串保存和加载
    test_account_id = "test_account"
    test_session_string = "test_session_string_12345"

    # 保存
    success = await session_mgr.save_session_string(test_account_id, test_session_string)
    assert success, "Failed to save session string"

    # 加载
    loaded_string = await session_mgr.load_session_string(test_account_id)
    assert loaded_string == test_session_string, "Session string mismatch"

    # 删除
    success = await session_mgr.delete_session(test_account_id)
    assert success, "Failed to delete session"

    # 验证已删除
    loaded_string = await session_mgr.load_session_string(test_account_id)
    assert loaded_string is None, "Session should be deleted"

    print("✅ SessionManager tests passed")


def test_types():
    """测试类型定义"""
    print("Testing type definitions...")

    # 创建测试账号
    account = TelegramAccount(
        id="test_id",
        name="Test Account",
        type=AccountType.CLIENT,
        token="test_api_hash",
        apiId=12345,
        apiHash="test_api_hash"
    )

    assert account.id == "test_id"
    assert account.type == AccountType.CLIENT
    assert account.apiId == 12345

    print("✅ Type definitions tests passed")


async def main():
    """主测试函数"""
    print("Running basic functionality tests...\n")

    try:
        test_types()
        await test_session_manager()

        print("\n🎉 All tests passed!")

    except Exception as e:
        print(f"\n❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
        return 1

    return 0


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
