from telegram_bridge.telegram_types import TelegramChannel


def test_telegram_channel_accepts_forum_flag_by_field_name():
    channel = TelegramChannel(
        id="123",
        title="Forum Group",
        type="supergroup",
        is_forum=True,
    )

    data = channel.dict()

    assert data["is_forum"] is True


def test_telegram_channel_accepts_forum_flag_by_alias():
    channel = TelegramChannel(
        id="123",
        title="Forum Group",
        type="supergroup",
        isForum=True,
    )

    data = channel.dict()

    assert data["is_forum"] is True
