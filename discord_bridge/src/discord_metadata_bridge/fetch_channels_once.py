import asyncio
import contextlib
import inspect
import json
import sys
from typing import Any, Dict, List

import discord


def _normalize_channel(channel: Any) -> Dict[str, Any]:
    raw_type = getattr(channel, "type", None)
    try:
        channel_type = int(raw_type.value) if hasattr(raw_type, "value") else int(raw_type)
    except Exception:
        channel_type = None
    return {
        "id": str(getattr(channel, "id", "") or ""),
        "name": getattr(channel, "name", None),
        "type": channel_type,
        "parentId": str(getattr(channel, "category_id", None) or getattr(channel, "parent_id", None) or "") or None,
        "position": getattr(channel, "position", None),
    }


def _resolve_private_channel_name(channel: Any) -> str:
    explicit_name = str(getattr(channel, "name", "") or "").strip()
    if explicit_name:
        return explicit_name
    recipients = list(getattr(channel, "recipients", []) or [])
    recipient_names = []
    for recipient in recipients:
        global_name = str(getattr(recipient, "global_name", "") or "").strip()
        username = str(getattr(recipient, "name", None) or getattr(recipient, "username", "") or "").strip()
        if global_name:
            recipient_names.append(global_name)
        elif username:
            recipient_names.append(username)
    if recipient_names:
        return ", ".join(recipient_names)
    return str(getattr(channel, "id", "") or "").strip()


def _normalize_private_channel(channel: Any) -> Dict[str, Any]:
    recipients = list(getattr(channel, "recipients", []) or [])
    return {
        "id": str(getattr(channel, "id", "") or ""),
        "name": _resolve_private_channel_name(channel),
        "type": _normalize_channel(channel).get("type"),
        "recipientCount": len(recipients),
    }


async def _run(payload: Dict[str, Any]) -> Dict[str, Any]:
    token = str(payload.get("token") or "").strip()
    guild_ids = [str(item) for item in (payload.get("guildIds") or []) if str(item).strip()]
    include_private_channels = payload.get("includePrivateChannels") is True
    client_type = payload.get("type") or "selfbot"
    if not token or (not guild_ids and not include_private_channels):
        return {"success": False, "error": "missing token or guildIds"}

    if hasattr(discord, "Intents"):
        intents = discord.Intents.default()
        intents.guilds = True
        intents.members = True
        intents.messages = True
        client = discord.Client(intents=intents)
    else:
        client = discord.Client()

    future: asyncio.Future = asyncio.get_running_loop().create_future()

    @client.event
    async def on_ready():
        channels_by_guild: Dict[str, List[Dict[str, Any]]] = {}
        private_channels: List[Dict[str, Any]] = []
        try:
            for guild_id in guild_ids:
                guild = client.get_guild(int(guild_id)) if hasattr(client, "get_guild") else None
                channels = list(getattr(guild, "channels", []) or []) if guild else []
                if not channels and guild and hasattr(guild, "fetch_channels"):
                    try:
                        channels = await guild.fetch_channels()
                    except Exception:
                        channels = []
                channels_by_guild[guild_id] = [_normalize_channel(ch) for ch in channels]
            if include_private_channels:
                private_channels = [
                    _normalize_private_channel(ch)
                    for ch in list(getattr(client, "private_channels", []) or [])
                ]
            future.set_result(
                {
                    "success": True,
                    "channelsByGuild": channels_by_guild,
                    "privateChannels": private_channels,
                }
            )
        except Exception as exc:
            future.set_result({"success": False, "error": str(exc)})
        finally:
            await client.close()

    start_fn = getattr(client, "start")
    kwargs = {}
    try:
        sig = inspect.signature(start_fn)
        if "bot" in sig.parameters:
            kwargs["bot"] = client_type == "bot"
    except Exception:
        kwargs = {}

    runner = asyncio.create_task(start_fn(token, **kwargs) if kwargs else start_fn(token))
    try:
        result = await asyncio.wait_for(future, timeout=90)
        return result
    finally:
        if not runner.done():
            runner.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await runner


def main():
    raw = sys.stdin.read().strip()
    payload = json.loads(raw or "{}")
    result = asyncio.run(_run(payload))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
