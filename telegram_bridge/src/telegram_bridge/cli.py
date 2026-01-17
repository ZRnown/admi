#!/usr/bin/env python3
"""
Telegram Bridge CLI工具
用于测试和调试各个组件
"""

import asyncio
import sys
import argparse
import json
from pathlib import Path
from .session import SessionManager


async def session_cli():
    """Session管理CLI"""
    parser = argparse.ArgumentParser(description="Session Manager CLI")
    parser.add_argument("action", choices=[
        "save", "load", "delete", "list", "backup", "exists",
        "import", "export", "convert-to-string", "convert-to-file", "migrate"
    ])
    parser.add_argument("account_id", nargs="?")
    parser.add_argument("--data", help="Session data for save action")
    parser.add_argument("--file", help="File path for import/export actions")
    parser.add_argument("--dir", default="~/.telegram-sessions", help="Sessions directory")

    args = parser.parse_args()

    session_mgr = SessionManager(args.dir)

    if args.action == "save":
        if not args.account_id or not args.data:
            print("Error: account_id and --data required for save action")
            return 1

        success = await session_mgr.save_session_string(args.account_id, args.data)
        print(f"Save result: {success}")

    elif args.action == "load":
        if not args.account_id:
            print("Error: account_id required for load action")
            return 1

        data = await session_mgr.load_session_string(args.account_id)
        if data:
            print(f"Loaded session: {data}")
        else:
            print("Session not found")

    elif args.action == "delete":
        if not args.account_id:
            print("Error: account_id required for delete action")
            return 1

        success = await session_mgr.delete_session(args.account_id)
        print(f"Delete result: {success}")

    elif args.action == "list":
        sessions = await session_mgr.list_sessions()
        print(json.dumps(sessions, indent=2))

    elif args.action == "backup":
        if not args.account_id:
            print("Error: account_id required for backup action")
            return 1

        success = await session_mgr.backup_session(args.account_id)
        print(f"Backup result: {success}")

    elif args.action == "exists":
        if not args.account_id:
            print("Error: account_id required for exists action")
            return 1

        exists = session_mgr.session_exists(args.account_id)
        print(f"Session exists: {exists}")

    elif args.action == "import":
        if not args.account_id or not args.file:
            print("Error: account_id and --file required for import action")
            return 1

        success = await session_mgr.import_session_from_file(args.account_id, args.file)
        print(f"Import result: {success}")

    elif args.action == "export":
        if not args.account_id or not args.file:
            print("Error: account_id and --file required for export action")
            return 1

        success = await session_mgr.export_session_to_file(args.account_id, args.file)
        print(f"Export result: {success}")

    elif args.action == "convert-to-string":
        if not args.account_id:
            print("Error: account_id required for convert-to-string action")
            return 1

        session_string = await session_mgr.convert_session_file_to_string(args.account_id)
        if session_string:
            print(f"Session string: {session_string}")
        else:
            print("Failed to convert session file to string")

    elif args.action == "convert-to-file":
        if not args.account_id or not args.data:
            print("Error: account_id and --data required for convert-to-file action")
            return 1

        success = await session_mgr.convert_session_string_to_file(args.account_id, args.data)
        print(f"Convert result: {success}")

    elif args.action == "migrate":
        results = await session_mgr.migrate_legacy_sessions()
        print(f"Migration results: {json.dumps(results, indent=2)}")

    return 0


async def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("Usage: python -m telegram_bridge.cli <command> [args...]")
        print("Commands: session")
        return 1

    command = sys.argv[1]

    if command == "session":
        return await session_cli()
    else:
        print(f"Unknown command: {command}")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
