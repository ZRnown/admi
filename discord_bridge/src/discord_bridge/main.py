import asyncio
import sys
import os
import inspect
from typing import Any, Dict, Optional, Set

from loguru import logger

from .ipc import IPCServer

try:
    import discord
except Exception as e:  # pragma: no cover - runtime dependency
    logger.error(f"discord.py-self not installed: {e}")
    discord = None


class DiscordAccountSession:
    """
    Discord 账号会话，支持多个账号共享同一个客户端连接。
    当多个账号使用相同的 token 时，只创建一个 Discord 客户端，
    但会将消息分发给所有使用该 token 的账号。
    """
    def __init__(self, account_id: str, token: str, client_type: str, ipc: IPCServer):
        if discord is None:
            raise RuntimeError("discord.py-self is not available")

        self.account_id = account_id  # 主账号 ID（第一个使用此 token 的账号）
        self.token = token
        self.client_type = client_type
        self.ipc = ipc
        self.listen_channels: Set[int] = set()
        self.client: Optional[discord.Client] = None
        self.task: Optional[asyncio.Task] = None
        self.ready_event: asyncio.Event = asyncio.Event()
        self.user_payload: Optional[Dict[str, Any]] = None
        self.login_timeout_seconds = int(os.getenv("DISCORD_LOGIN_TIMEOUT_SECONDS", "120"))
        # 共享此客户端的所有账号 ID 及其监听频道
        self.shared_accounts: Dict[str, Set[int]] = {account_id: set()}
        self._build_client()

    def _build_client(self) -> None:
        if hasattr(discord, "Intents"):
            intents = discord.Intents.default()
            intents.message_content = True
            intents.guilds = True
            intents.members = True
            intents.messages = True
            self.client = discord.Client(intents=intents)
        else:
            # 兼容旧版/精简版 discord.py-self
            self.client = discord.Client()

        @self.client.event
        async def on_ready():
            self.ready_event.set()
            user = getattr(self.client, "user", None)
            payload = None
            if user:
                payload = {
                    "id": str(user.id),
                    "username": getattr(user, "name", None) or getattr(user, "username", None),
                    "displayName": getattr(user, "display_name", None),
                    "tag": getattr(user, "name", None) or getattr(user, "username", None),
                }
                self.user_payload = payload
            # 为所有共享此客户端的账号发送状态通知
            for acc_id in self.shared_accounts.keys():
                await self.ipc.send_notification(
                    "discord_status",
                    {
                        "accountId": acc_id,
                        "state": "online",
                        "user": payload,
                    },
                )
            shared_count = len(self.shared_accounts)
            user_label = None
            if payload:
                user_label = payload.get("tag") or payload.get("username") or payload.get("displayName")
            if shared_count > 1:
                logger.info(
                    f"Discord账号已连接 | 账号={self.account_id} | 用户={user_label or '未知'} | 共享={shared_count}"
                )
            else:
                logger.info(
                    f"Discord账号已连接 | 账号={self.account_id} | 用户={user_label or '未知'}"
                )

        @self.client.event
        async def on_disconnect():
            # 为所有共享此客户端的账号发送断开通知
            for acc_id in self.shared_accounts.keys():
                await self.ipc.send_notification(
                    "discord_status",
                    {"accountId": acc_id, "state": "disconnected"},
                )
            logger.warning(f"Discord account {self.account_id} disconnected")

        @self.client.event
        async def on_resumed():
            # 为所有共享此客户端的账号发送恢复通知
            for acc_id in self.shared_accounts.keys():
                await self.ipc.send_notification(
                    "discord_status",
                    {
                        "accountId": acc_id,
                        "state": "online",
                        "user": self.user_payload,
                    },
                )
            logger.info(f"Discord account {self.account_id} resumed")

        @self.client.event
        async def on_message(message: Any):
            if message is None:
                return
            try:
                channel_id = getattr(message.channel, "id", None)
                if channel_id is None:
                    return
                channel_id_int = int(channel_id)

                # 找出所有监听此频道的账号
                target_accounts = []
                for acc_id, channels in self.shared_accounts.items():
                    # 如果账号没有配置监听频道（空集合），则监听所有频道
                    # 否则只监听配置的频道
                    if not channels or channel_id_int in channels:
                        target_accounts.append(acc_id)

                if not target_accounts:
                    return

                if getattr(message, "reference", None) and getattr(message.reference, "message_id", None):
                    try:
                        if hasattr(message, "fetch_reference"):
                            resolved_ref = await message.fetch_reference()
                            if resolved_ref is not None:
                                setattr(message, "_resolved_reference", resolved_ref)
                    except Exception:
                        pass

                # 为每个监听此频道的账号发送消息
                for acc_id in target_accounts:
                    payload = build_message_payload(message, acc_id)
                    await self.ipc.send_notification("discord_message", payload)
            except Exception as exc:
                logger.error(f"Failed to handle message: {exc}")

    def _resolve_start_kwargs(self, bot_flag: Optional[bool]) -> Dict[str, Any]:
        kwargs: Dict[str, Any] = {}
        try:
            sig = inspect.signature(self.client.start)
            if "bot" in sig.parameters and bot_flag is not None:
                kwargs["bot"] = bot_flag
        except Exception:
            pass
        return kwargs

    async def _start_client(self, bot_flag: Optional[bool]) -> None:
        start_fn = self.client.start
        kwargs = self._resolve_start_kwargs(bot_flag)
        if kwargs:
            try:
                return await start_fn(self.token, **kwargs)
            except TypeError:
                # 兼容不支持 bot 参数的实现
                return await start_fn(self.token)
        return await start_fn(self.token)

    async def start(self) -> None:
        if not self.client:
            raise RuntimeError("Client not initialized")
        if self.task and not self.task.done():
            return
        self.task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        max_retries = 3
        retry_delay = 2  # 秒
        last_error = None
        mode_override: Optional[bool] = None

        for attempt in range(max_retries):
            try:
                # 为所有共享账号发送连接中状态
                for acc_id in self.shared_accounts.keys():
                    await self.ipc.send_notification(
                        "discord_status",
                        {"accountId": acc_id, "state": "connecting"},
                    )

                # 重试时重新创建客户端
                if attempt > 0:
                    logger.info(f"Retry {attempt + 1}/{max_retries} for account {self.account_id}")
                    await asyncio.sleep(retry_delay)
                    # 重新初始化客户端
                    if self.client:
                        try:
                            await self.client.close()
                        except Exception:
                            pass
                    self._build_client()
                    self.ready_event = asyncio.Event()

                # 启动客户端并等待 ready（超时则报错）
                bot_flag = mode_override
                if bot_flag is None:
                    bot_flag = True if self.client_type == "bot" else False
                mode_label = "bot" if bot_flag else "user"
                logger.info(
                    f"Discord account {self.account_id} starting in {mode_label} mode"
                )
                client_task = asyncio.create_task(self._start_client(bot_flag))
                ready_task = asyncio.create_task(self.ready_event.wait())
                done, pending = await asyncio.wait(
                    {client_task, ready_task},
                    timeout=self.login_timeout_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )

                if ready_task in done:
                    # 登录成功，保持运行
                    try:
                        await client_task
                    finally:
                        if not ready_task.done():
                            ready_task.cancel()
                    return

                # 客户端提前结束（登录失败）
                if client_task in done:
                    exc = client_task.exception()
                    raise exc or RuntimeError("DISCORD_LOGIN_FAILED")

                # 超时
                try:
                    await self.client.close()
                except Exception:
                    pass
                client_task.cancel()
                raise RuntimeError(f"DISCORD_LOGIN_TIMEOUT({self.login_timeout_seconds}s)")

            except Exception as exc:
                last_error = exc
                error_str = str(exc)
                lower_error = error_str.lower()
                if (
                    mode_override is None
                    and ("improper token" in lower_error or "loginfailure" in lower_error)
                ):
                    # 可能是 bot/selfbot 模式判断错误，尝试切换一次
                    mode_override = not (True if self.client_type == "bot" else False)
                    logger.warning(
                        f"Discord account {self.account_id} failed with {error_str}, retrying in "
                        f"{'bot' if mode_override else 'user'} mode..."
                    )
                    continue
                # 检查是否是可重试的错误（如 sequence 错误）
                is_retryable = (
                    "sequence" in error_str.lower() or
                    "'NoneType' object has no attribute" in error_str or
                    "connection" in error_str.lower()
                )

                if is_retryable and attempt < max_retries - 1:
                    logger.warning(
                        f"Discord account {self.account_id} encountered retryable error: {exc}, retrying..."
                    )
                    continue

                # 不可重试或已达最大重试次数，发送错误状态
                for acc_id in self.shared_accounts.keys():
                    await self.ipc.send_notification(
                        "discord_status",
                        {
                            "accountId": acc_id,
                            "state": "error",
                            "error": str(exc),
                        },
                    )
                logger.error(f"Discord account {self.account_id} failed to start: {exc}")
                return

        # 所有重试都失败
        if last_error:
            for acc_id in self.shared_accounts.keys():
                await self.ipc.send_notification(
                    "discord_status",
                    {
                        "accountId": acc_id,
                        "state": "error",
                        "error": str(last_error),
                    },
                )
            logger.error(f"Discord account {self.account_id} failed after {max_retries} retries: {last_error}")

    async def stop(self) -> None:
        if self.client:
            try:
                await self.client.close()
            except Exception as exc:
                logger.error(f"Failed to close Discord client {self.account_id}: {exc}")
        if self.task and not self.task.done():
            self.task.cancel()

    def update_listen_channels(self, account_id: str, channels: Optional[list]) -> None:
        """更新指定账号的监听频道"""
        channel_set = set(int(c) for c in channels or [] if str(c).strip())
        self.shared_accounts[account_id] = channel_set
        # 更新总的监听频道集合（所有共享账号的并集）
        self._update_total_listen_channels()

    def _update_total_listen_channels(self) -> None:
        """更新总的监听频道集合"""
        all_channels: Set[int] = set()
        for channels in self.shared_accounts.values():
            all_channels.update(channels)
        self.listen_channels = all_channels

    async def add_shared_account(self, account_id: str, channels: Optional[list] = None) -> None:
        """添加共享账号"""
        channel_set = set(int(c) for c in channels or [] if str(c).strip())
        self.shared_accounts[account_id] = channel_set
        self._update_total_listen_channels()
        logger.info(f"Added shared account {account_id} to session {self.account_id}")
        # 如果客户端已连接，为新加入的账号发送当前状态
        if self.ready_event.is_set():
            await self.ipc.send_notification(
                "discord_status",
                {
                    "accountId": account_id,
                    "state": "online",
                    "user": self.user_payload,
                },
            )

    async def remove_shared_account(self, account_id: str) -> bool:
        """移除共享账号，返回是否还有剩余账号"""
        if account_id in self.shared_accounts:
            del self.shared_accounts[account_id]
            self._update_total_listen_channels()
            logger.info(f"Removed shared account {account_id} from session {self.account_id}")
            # 为移除的账号发送断开状态
            await self.ipc.send_notification(
                "discord_status",
                {"accountId": account_id, "state": "idle"},
            )
        return len(self.shared_accounts) > 0

    def has_account(self, account_id: str) -> bool:
        """检查是否包含指定账号"""
        return account_id in self.shared_accounts


class DiscordBridge:
    def __init__(self):
        self.ipc_server = IPCServer()
        # 按 token 索引的 session（多个账号可能共享同一个 session）
        self.sessions_by_token: Dict[str, DiscordAccountSession] = {}
        # 账号 ID 到 token 的映射
        self.account_to_token: Dict[str, str] = {}

    async def start(self):
        self.ipc_server.register_handler("updateConfig", self._handle_update_config)
        await self.ipc_server.start()

    async def _handle_update_config(self, params: Dict[str, Any]):
        accounts = params.get("accounts") or []

        # 按 token 分组账号
        token_groups: Dict[str, list] = {}
        for entry in accounts:
            account_id = entry.get("id")
            token = entry.get("token")
            enabled = entry.get("enabled") is True

            if not account_id or not token or not enabled:
                continue
            if isinstance(token, str):
                token = token.strip()
                if token.lower().startswith("bot "):
                    token = token[4:].strip()
            if not token:
                continue

            if token not in token_groups:
                token_groups[token] = []
            token_groups[token].append(entry)

        # 记录所有需要保留的账号 ID
        desired_ids = set()
        desired_tokens = set()

        for token, group in token_groups.items():
            desired_tokens.add(token)
            for entry in group:
                desired_ids.add(entry.get("id"))

        # 处理每个 token 组
        for token, group in token_groups.items():
            primary_entry = group[0]
            primary_id = primary_entry.get("id")
            client_type = primary_entry.get("type") or "selfbot"

            # 检查是否已有此 token 的 session
            session = self.sessions_by_token.get(token)

            if not session:
                # 创建新 session
                session = DiscordAccountSession(primary_id, token, client_type, self.ipc_server)
                self.sessions_by_token[token] = session
                await session.start()
                if len(group) > 1:
                    logger.info(f"Created shared session for {len(group)} accounts using token {token[:20]}...")

            # 更新所有账号的监听频道
            for entry in group:
                acc_id = entry.get("id")
                listen_channels = entry.get("listenChannels") or []
                self.account_to_token[acc_id] = token

                if session.has_account(acc_id):
                    session.update_listen_channels(acc_id, listen_channels)
                else:
                    await session.add_shared_account(acc_id, listen_channels)

        # 清理不再需要的账号
        for acc_id in list(self.account_to_token.keys()):
            if acc_id not in desired_ids:
                token = self.account_to_token.pop(acc_id, None)
                if token and token in self.sessions_by_token:
                    session = self.sessions_by_token[token]
                    has_remaining = await session.remove_shared_account(acc_id)
                    if not has_remaining:
                        await session.stop()
                        self.sessions_by_token.pop(token, None)

        # 清理不再需要的 session
        for token in list(self.sessions_by_token.keys()):
            if token not in desired_tokens:
                session = self.sessions_by_token.pop(token, None)
                if session:
                    await session.stop()

        total_accounts = sum(len(s.shared_accounts) for s in self.sessions_by_token.values())
        return {"success": True, "sessions": len(self.sessions_by_token), "accounts": total_accounts}


def build_message_payload(message: Any, account_id: str) -> Dict[str, Any]:
    author = getattr(message, "author", None)
    member = getattr(message, "author", None)
    guild = getattr(message, "guild", None)
    created_at = getattr(message, "created_at", None)
    created_ts = None
    if created_at:
        created_ts = int(created_at.timestamp() * 1000)

    attachments = []
    for attachment in getattr(message, "attachments", []) or []:
        attachments.append(
            {
                "id": str(getattr(attachment, "id", "")),
                "url": getattr(attachment, "url", None),
                "filename": getattr(attachment, "filename", None),
                "contentType": getattr(attachment, "content_type", None),
                "size": getattr(attachment, "size", None),
                "width": getattr(attachment, "width", None),
                "height": getattr(attachment, "height", None),
            }
        )

    embeds = []
    for embed in getattr(message, "embeds", []) or []:
        try:
            embeds.append(embed.to_dict())
        except Exception:
            try:
                embeds.append(dict(embed))
            except Exception:
                pass

    mentions = {
        "users": [],
        "roles": [],
        "channels": [],
    }
    for user in getattr(message, "mentions", []) or []:
        mentions["users"].append(
            {
                "id": str(getattr(user, "id", "")),
                "username": getattr(user, "name", None) or getattr(user, "username", None),
                "displayName": getattr(user, "display_name", None),
            }
        )
    for role in getattr(message, "role_mentions", []) or []:
        mentions["roles"].append(
            {
                "id": str(getattr(role, "id", "")),
                "name": getattr(role, "name", None),
            }
        )
    for channel in getattr(message, "channel_mentions", []) or []:
        mentions["channels"].append(
            {
                "id": str(getattr(channel, "id", "")),
                "name": getattr(channel, "name", None),
            }
        )

    reference = None
    ref = getattr(message, "reference", None)
    if ref is not None:
        reference = {
            "messageId": str(getattr(ref, "message_id", "")) if getattr(ref, "message_id", None) else None,
            "channelId": str(getattr(ref, "channel_id", "")) if getattr(ref, "channel_id", None) else None,
        }

    author_avatar = None
    if author:
        try:
            display_avatar = getattr(author, "display_avatar", None)
            if display_avatar is not None and getattr(display_avatar, "url", None):
                author_avatar = str(display_avatar.url)
            else:
                avatar = getattr(author, "avatar", None)
                if avatar is not None and getattr(avatar, "url", None):
                    author_avatar = str(avatar.url)
                elif getattr(author, "avatar_url", None):
                    author_avatar = str(getattr(author, "avatar_url"))
        except Exception:
            author_avatar = None

    reference_message = None
    resolved = getattr(ref, "resolved", None)
    if resolved is None:
        resolved = getattr(message, "_resolved_reference", None)
    if ref is not None and resolved is not None:
        try:
            ref_author = getattr(resolved, "author", None)
            ref_created = getattr(resolved, "created_at", None)
            ref_created_ts = int(ref_created.timestamp() * 1000) if ref_created else None
            ref_attachments = []
            for attachment in getattr(resolved, "attachments", []) or []:
                ref_attachments.append(
                    {
                        "id": str(getattr(attachment, "id", "")),
                        "url": getattr(attachment, "url", None),
                        "filename": getattr(attachment, "filename", None),
                        "contentType": getattr(attachment, "content_type", None),
                        "size": getattr(attachment, "size", None),
                        "width": getattr(attachment, "width", None),
                        "height": getattr(attachment, "height", None),
                    }
                )
            ref_embeds = []
            for embed in getattr(resolved, "embeds", []) or []:
                try:
                    ref_embeds.append(embed.to_dict())
                except Exception:
                    try:
                        ref_embeds.append(dict(embed))
                    except Exception:
                        pass
            ref_avatar = None
            if ref_author:
                try:
                    display_avatar = getattr(ref_author, "display_avatar", None)
                    if display_avatar is not None and getattr(display_avatar, "url", None):
                        ref_avatar = str(display_avatar.url)
                    else:
                        avatar = getattr(ref_author, "avatar", None)
                        if avatar is not None and getattr(avatar, "url", None):
                            ref_avatar = str(avatar.url)
                        elif getattr(ref_author, "avatar_url", None):
                            ref_avatar = str(getattr(ref_author, "avatar_url"))
                except Exception:
                    ref_avatar = None
            reference_message = {
                "id": str(getattr(resolved, "id", "")),
                "content": getattr(resolved, "content", None),
                "createdTimestamp": ref_created_ts,
                "author": {
                    "id": str(getattr(ref_author, "id", "")) if ref_author else None,
                    "username": getattr(ref_author, "name", None) or getattr(ref_author, "username", None) if ref_author else None,
                    "displayName": getattr(ref_author, "display_name", None) if ref_author else None,
                    "avatarUrl": ref_avatar,
                },
                "member": {
                    "displayName": getattr(getattr(resolved, "author", None), "display_name", None) if resolved else None,
                },
                "attachments": ref_attachments,
                "embeds": ref_embeds,
            }
        except Exception:
            reference_message = None

    payload = {
        "accountId": account_id,
        "id": str(getattr(message, "id", "")),
        "channelId": str(getattr(message.channel, "id", "")),
        "guildId": str(getattr(guild, "id", "")) if guild else None,
        "content": getattr(message, "content", None),
        "createdTimestamp": created_ts,
        "type": getattr(getattr(message, "type", None), "value", None),
        "system": bool(getattr(message, "type", None) and getattr(message.type, "value", 0) != 0),
        "webhookId": getattr(message, "webhook_id", None),
        "author": {
            "id": str(getattr(author, "id", "")) if author else None,
            "username": getattr(author, "name", None) or getattr(author, "username", None) if author else None,
            "displayName": getattr(author, "display_name", None) if author else None,
            "bot": bool(getattr(author, "bot", False)) if author else False,
            "avatarUrl": author_avatar,
        },
        "member": {
            "displayName": getattr(member, "display_name", None) if member else None,
            "roles": [
                {
                    "id": str(getattr(role, "id", "")),
                    "name": getattr(role, "name", None),
                }
                for role in getattr(member, "roles", []) or []
            ],
        },
        "attachments": attachments,
        "embeds": embeds,
        "mentions": mentions,
        "reference": reference,
        "referenceMessage": reference_message,
    }
    return payload


async def main():
    # 配置日志，移除默认处理器避免重复
    logger.remove()
    logger.add(sys.stderr, level="INFO", format="{time} {level} {message}")

    bridge = DiscordBridge()
    await bridge.start()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
