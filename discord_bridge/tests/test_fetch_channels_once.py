import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import discord_metadata_bridge.fetch_channels_once as fetch_channels_once


class _FakeClient:
    def __init__(self, *args, **kwargs):
        self._events = {}

    def event(self, fn):
        self._events[fn.__name__] = fn
        return fn

    async def start(self, token, **kwargs):
        await asyncio.sleep(3600)

    async def close(self):
        return None


class _FakeIntents:
    def __init__(self):
        self.guilds = False
        self.members = False
        self.messages = False

    @staticmethod
    def default():
        return _FakeIntents()


def test_run_cancels_runner_without_name_error(monkeypatch):
    monkeypatch.setattr(fetch_channels_once.discord, "Intents", _FakeIntents, raising=False)
    monkeypatch.setattr(fetch_channels_once.discord, "Client", _FakeClient)

    async def fake_wait_for(awaitable, timeout):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(fetch_channels_once.asyncio, "wait_for", fake_wait_for)

    with pytest.raises(asyncio.TimeoutError):
        asyncio.run(
            fetch_channels_once._run(
                {
                    "token": "fake-token",
                    "guildIds": ["123"],
                }
            )
        )


def test_normalize_private_channel_prefers_recipient_names():
    channel = SimpleNamespace(
        id=456,
        name=None,
        type=SimpleNamespace(value=1),
        recipients=[
            SimpleNamespace(global_name="Alice", name="alice"),
            SimpleNamespace(global_name="", name="bob"),
        ],
    )

    assert fetch_channels_once._normalize_private_channel(channel) == {
        "id": "456",
        "name": "Alice, bob",
        "type": 1,
        "recipientCount": 2,
    }
