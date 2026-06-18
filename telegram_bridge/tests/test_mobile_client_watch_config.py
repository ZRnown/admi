from pathlib import Path


def test_mobile_client_mappings_are_registered_as_watched_chats():
    source = Path(__file__).resolve().parents[1] / "src" / "telegram_bridge" / "main.py"
    text = source.read_text(encoding="utf-8")

    assert '"telegram-to-mobile-client"' in text
    assert 'mapping.type not in ["telegram-to-discord", "telegram-to-telegram", "telegram-to-mobile-client"]' in text


def test_ipc_payload_preserves_forum_topic_fields():
    source = Path(__file__).resolve().parents[1] / "src" / "telegram_bridge" / "main.py"
    text = source.read_text(encoding="utf-8")

    assert '"reply_to_top_id": message_data.get("reply_to_top_id")' in text
    assert '"message_thread_id": message_data.get("message_thread_id")' in text
    assert '"is_forum_topic": message_data.get("is_forum_topic")' in text
