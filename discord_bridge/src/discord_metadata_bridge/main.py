import asyncio
import inspect
import os
import sys
from typing import Any, Dict, Optional, Set

from loguru import logger

from discord_bridge.ipc import IPCServer

try:
    import discord
except Exception as e:
    logger.error(f"discord.py-self not installed: {e}")
    discord = None


class MetadataSession:
    def __init__(self, account_id: str, token: str, client_type: str, ipc: IPCServer):
        if discord is None:
            raise RuntimeError("discord.py-self is not available")
        self.account_id = account_id
        self.token = token
        self.client_type = client_type
        self.ipc = ipc
        self.client: Optional[discord.Client] = None
        self.task: Optional[asyncio.Task] = None
        self.ready_event: asyncio.Event = asyncio.Event()
        self.user_payload: Optional[Dict[str, Any]] = None
        self.shared_accounts: Dict[str, None] = {account_id: None}
        self.extra_channels_by_guild: Dict[str, list] = {}
        self._build_client()

    def _build_client(self) -> None:
        if hasattr(discord, "Intents"):
            intents = discord.Intents.default()
            intents.guilds = True
            intents.members = True
            intents.messages = True
            self.client = discord.Client(intents=intents)
        else:
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
            for acc_id in self.shared_accounts.keys():
                await self.ipc.send_notification(
                    "discord_metadata_status",
                    {"accountId": acc_id, "state": "online", "user": payload},
                )
            await self.emit_cache_snapshot()
            asyncio.create_task(self._hydrate_and_emit_cache_snapshot(5))
            asyncio.create_task(self._hydrate_and_emit_cache_snapshot(15))
            logger.info(f"Discord metadata session ready for {self.account_id}")

        @self.client.event
        async def on_disconnect():
            for acc_id in self.shared_accounts.keys():
                await self.ipc.send_notification(
                    "discord_metadata_status",
                    {"accountId": acc_id, "state": "disconnected"},
                )

    def _channel_type_value(self, channel: Any) -> Optional[int]:
        raw = getattr(channel, "type", None)
        if raw is None:
            return None
        try:
            return int(raw.value) if hasattr(raw, "value") else int(raw)
        except Exception:
            return None

    def build_cache_snapshot(self) -> Dict[str, Any]:
        guilds_payload = []
        channels_by_guild: Dict[str, list] = {}
        client = self.client
        if not client or not getattr(client, "guilds", None):
            return {"user": self.user_payload, "guilds": guilds_payload, "channelsByGuild": channels_by_guild}

        for guild in getattr(client, "guilds", []) or []:
            guild_id = str(getattr(guild, "id", "") or "")
            if not guild_id:
                continue
            guilds_payload.append({
                "id": guild_id,
                "name": getattr(guild, "name", None),
                "icon": getattr(guild, "icon", None),
            })
            cached_channels = list(getattr(guild, "channels", []) or [])
            source_channels = cached_channels if cached_channels else self.extra_channels_by_guild.get(guild_id, [])
            channels = []
            for channel in source_channels:
                channels.append({
                    "id": str(getattr(channel, "id", "") or (channel.get("id") if isinstance(channel, dict) else "")),
                    "name": getattr(channel, "name", None) if not isinstance(channel, dict) else channel.get("name"),
                    "type": self._channel_type_value(channel) if not isinstance(channel, dict) else channel.get("type"),
                    "parentId": (
                        str(getattr(channel, "category_id", None) or getattr(channel, "parent_id", None) or "") or None
                        if not isinstance(channel, dict)
                        else channel.get("parentId")
                    ),
                    "position": getattr(channel, "position", None) if not isinstance(channel, dict) else channel.get("position"),
                })
            channels_by_guild[guild_id] = channels
        return {"user": self.user_payload, "guilds": guilds_payload, "channelsByGuild": channels_by_guild}

    async def hydrate_empty_guild_channels(self) -> int:
        client = self.client
        if not client or not self.ready_event.is_set():
            return 0
        hydrated = 0
        for guild in getattr(client, "guilds", []) or []:
            guild_id = str(getattr(guild, "id", "") or "")
            if not guild_id:
                continue
            cached_channels = list(getattr(guild, "channels", []) or [])
            if cached_channels:
                continue
            try:
                subscribe = getattr(guild, "subscribe", None)
                if callable(subscribe):
                    await subscribe(typing=True, threads=True, member_updates=False)
                    await asyncio.sleep(0.5)
            except Exception:
                pass
            fetched_channels = []
            try:
                fetch_channels = getattr(guild, "fetch_channels", None)
                if callable(fetch_channels):
                    fetched_channels = await fetch_channels()
            except Exception as exc:
                logger.debug(f"guild.fetch_channels failed for {guild_id}: {exc}")
            if fetched_channels:
                self.extra_channels_by_guild[guild_id] = [
                    {
                        "id": str(getattr(ch, "id", "") or ""),
                        "name": getattr(ch, "name", None),
                        "type": self._channel_type_value(ch),
                        "parentId": str(getattr(ch, "category_id", None) or getattr(ch, "parent_id", None) or "") or None,
                        "position": getattr(ch, "position", None),
                    }
                    for ch in fetched_channels
                ]
                hydrated += 1
        return hydrated

    async def emit_cache_snapshot(self, account_ids: Optional[list] = None) -> None:
        snapshot = self.build_cache_snapshot()
        target_ids = account_ids or list(self.shared_accounts.keys())
        for acc_id in target_ids:
            await self.ipc.send_notification(
                "discord_metadata_snapshot",
                {"accountId": acc_id, **snapshot},
            )

    async def _hydrate_and_emit_cache_snapshot(self, delay_seconds: float) -> None:
        try:
            await asyncio.sleep(delay_seconds)
            if not self.ready_event.is_set():
                return
            hydrated = await self.hydrate_empty_guild_channels()
            if hydrated > 0:
                logger.info(f"Metadata hydrated empty guild channels: {hydrated}")
            await self.emit_cache_snapshot()
        except Exception as exc:
            logger.debug(f"Metadata hydrate snapshot skipped: {exc}")

    async def start(self):
        if self.task and not self.task.done():
            return
        self.task = asyncio.create_task(self._runner())

    async def _runner(self):
        if self.client is None:
            raise RuntimeError("Client not initialized")
        start_fn = getattr(self.client, "start")
        kwargs = {}
        try:
            sig = inspect.signature(start_fn)
            if "bot" in sig.parameters:
                kwargs["bot"] = self.client_type == "bot"
        except Exception:
            kwargs = {}
        try:
            if kwargs:
                await start_fn(self.token, **kwargs)
            else:
                await start_fn(self.token)
        finally:
            self.ready_event = asyncio.Event()

    async def stop(self):
        if self.client:
            close = getattr(self.client, "close", None)
            if callable(close):
                await close()
        if self.task and not self.task.done():
            self.task.cancel()

    async def add_shared_account(self, account_id: str) -> None:
        self.shared_accounts[account_id] = None
        if self.ready_event.is_set():
            await self.ipc.send_notification(
                "discord_metadata_status",
                {"accountId": account_id, "state": "online", "user": self.user_payload},
            )
            await self.emit_cache_snapshot([account_id])

    async def remove_shared_account(self, account_id: str) -> bool:
        if account_id in self.shared_accounts:
            del self.shared_accounts[account_id]
            await self.ipc.send_notification(
                "discord_metadata_status",
                {"accountId": account_id, "state": "idle"},
            )
        return len(self.shared_accounts) > 0

    def has_account(self, account_id: str) -> bool:
        return account_id in self.shared_accounts


class DiscordMetadataService:
    def __init__(self):
        self.ipc_server = IPCServer()
        self.sessions_by_token: Dict[str, MetadataSession] = {}
        self.account_to_token: Dict[str, str] = {}

    async def start(self):
        self.ipc_server.register_handler("updateConfig", self._handle_update_config)
        self.ipc_server.register_handler("getCacheSnapshot", self._handle_get_cache_snapshot)
        await self.ipc_server.start()

    async def _handle_get_cache_snapshot(self, params: Dict[str, Any]):
        account_id = params.get("accountId")
        if not account_id:
            return {"success": False, "error": "missing accountId"}
        token = self.account_to_token.get(account_id)
        if not token:
            return {"success": False, "error": "account not connected"}
        session = self.sessions_by_token.get(token)
        if not session:
            return {"success": False, "error": "session not found"}
        return {"accountId": account_id, **session.build_cache_snapshot()}

    async def _handle_update_config(self, params: Dict[str, Any]):
        accounts = params.get("accounts") or []
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
            token_groups.setdefault(token, []).append(entry)

        desired_ids = set()
        desired_tokens = set()
        for token, group in token_groups.items():
            desired_tokens.add(token)
            for entry in group:
                desired_ids.add(entry.get("id"))

        for token, group in token_groups.items():
            primary_entry = group[0]
            primary_id = primary_entry.get("id")
            client_type = primary_entry.get("type") or "selfbot"
            session = self.sessions_by_token.get(token)
            if not session:
                session = MetadataSession(primary_id, token, client_type, self.ipc_server)
                self.sessions_by_token[token] = session
                await session.start()
            for entry in group:
                acc_id = entry.get("id")
                self.account_to_token[acc_id] = token
                if session.has_account(acc_id):
                    if session.ready_event.is_set():
                        await self.ipc_server.send_notification(
                            "discord_metadata_status",
                            {"accountId": acc_id, "state": "online", "user": session.user_payload},
                        )
                else:
                    await session.add_shared_account(acc_id)

        for acc_id in list(self.account_to_token.keys()):
            if acc_id not in desired_ids:
                token = self.account_to_token.pop(acc_id, None)
                if token and token in self.sessions_by_token:
                    session = self.sessions_by_token[token]
                    has_remaining = await session.remove_shared_account(acc_id)
                    if not has_remaining:
                        await session.stop()
                        self.sessions_by_token.pop(token, None)

        for token in list(self.sessions_by_token.keys()):
            if token not in desired_tokens:
                session = self.sessions_by_token.pop(token, None)
                if session:
                    await session.stop()

        total_accounts = sum(len(s.shared_accounts) for s in self.sessions_by_token.values())
        return {"success": True, "sessions": len(self.sessions_by_token), "accounts": total_accounts}


async def _amain():
    service = DiscordMetadataService()
    await service.start()
    await asyncio.Event().wait()


def main():
    logger.remove()
    logger.add(sys.stderr, level="INFO")
    try:
        asyncio.run(_amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
