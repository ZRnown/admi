import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import discord_bridge.main as bridge_main


class _FakeClient:
    def __init__(self, *args, **kwargs):
        self._events = {}
        self.user = None

    def event(self, fn):
        self._events[fn.__name__] = fn
        return fn

    async def start(self, token, **kwargs):
        await asyncio.sleep(3600)

    async def close(self):
        return None


class _FakeIntents:
    def __init__(self):
        self.message_content = False
        self.guilds = False
        self.members = False
        self.messages = False

    @staticmethod
    def default():
        return _FakeIntents()


class _FakeIPC:
    def __init__(self):
        self.notifications = []

    async def send_notification(self, method, params):
        self.notifications.append((method, params))


def test_add_shared_account_replays_last_error_status(monkeypatch):
    monkeypatch.setattr(bridge_main.discord, "Intents", _FakeIntents, raising=False)
    monkeypatch.setattr(bridge_main.discord, "Client", _FakeClient)

    ipc = _FakeIPC()
    session = bridge_main.DiscordAccountSession("primary", "token", "selfbot", ipc)
    session.last_status = {"state": "error", "error": "Improper token has been passed."}

    asyncio.run(session.add_shared_account("shared"))

    assert (
        "discord_status",
        {
            "accountId": "shared",
            "state": "error",
            "error": "Improper token has been passed.",
        },
    ) in ipc.notifications
