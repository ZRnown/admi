from telegram_bridge.connection import ConnectionManager
from telegram_bridge.connection_errors import ThrottledErrorLogger, classify_disconnect_error
from telegram_bridge.telegram_types import ConnectionStatus


def test_classify_idle_close_error():
    classified = classify_disconnect_error(
        RuntimeError("Server closed the connection: 0 bytes read on a total of 8 expected bytes")
    )
    assert classified.category == "network_idle_close"
    assert classified.transient is True


def test_throttled_logger_suppresses_repeated_error():
    throttled = ThrottledErrorLogger(window_seconds=60)
    throttled.log("acc-1", "ctx", RuntimeError("timeout"))
    throttled.log("acc-1", "ctx", RuntimeError("timeout"))

    record = throttled._records[("acc-1", "timeout")]
    assert int(record["suppressed"]) == 1


def test_connection_manager_tracks_recovery_fields():
    manager = ConnectionManager()

    manager.update_state("acc-2", ConnectionStatus.CONNECTED)
    manager.update_state(
        "acc-2",
        ConnectionStatus.ERROR,
        "Server closed the connection: 0 bytes read on a total of 8 expected bytes",
    )

    state = manager.get_state("acc-2")
    assert state is not None
    assert state.last_disconnect_reason is not None
    assert state.consecutive_disconnect_count == 1

    manager.update_state("acc-2", ConnectionStatus.CONNECTED)
    state = manager.get_state("acc-2")
    assert state is not None
    assert state.last_recovery_duration_ms is not None
    assert state.consecutive_disconnect_count == 0
