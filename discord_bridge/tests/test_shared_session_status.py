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


class _FakeAttachment:
    id = 1
    url = "https://cdn.discordapp.com/attachments/1/chart.png"
    filename = "chart.png"
    content_type = "image/png"
    size = 12
    width = 100
    height = 80


class _FakeChannel:
    id = 123

    async def fetch_message(self, message_id):
        return _FakeMessage(message_id, attachments=[_FakeAttachment()])


class _FakeMessage:
    def __init__(self, message_id, attachments=None):
        self.id = message_id
        self.channel = _FakeChannel()
        self.attachments = attachments or []
        self.embeds = []
        self.author = None
        self.guild = None
        self.created_at = None
        self.content = "late image"
        self.mentions = []
        self.role_mentions = []
        self.channel_mentions = []
        self.reference = None


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


def test_late_media_refetch_emits_message_update(monkeypatch):
    monkeypatch.setattr(bridge_main.discord, "Intents", _FakeIntents, raising=False)
    monkeypatch.setattr(bridge_main.discord, "Client", _FakeClient)
    monkeypatch.setattr(bridge_main, "LATE_MEDIA_REFETCH_SECONDS", 0.001)

    ipc = _FakeIPC()
    session = bridge_main.DiscordAccountSession("primary", "token", "selfbot", ipc)

    asyncio.run(session._emit_late_media_update(_FakeMessage(456), ["primary"]))

    assert ipc.notifications
    method, payload = ipc.notifications[-1]
    assert method == "discord_message_update"
    assert payload["id"] == "456"
    assert payload["lateMediaRefetch"] is True
    assert payload["attachments"][0]["filename"] == "chart.png"
