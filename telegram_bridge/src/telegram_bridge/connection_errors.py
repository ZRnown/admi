"""Helpers for classifying and throttling noisy Telegram connection errors."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Dict, Tuple

from loguru import logger


@dataclass
class TelegramDisconnectClassification:
    category: str
    message: str
    transient: bool
    fingerprint: str


def classify_disconnect_error(error: object) -> TelegramDisconnectClassification:
    message = str(error or "unknown error").strip() or "unknown error"
    lowered = message.lower()

    if "0 bytes read on a total of 8 expected bytes" in lowered:
        return TelegramDisconnectClassification(
            category="network_idle_close",
            message=message,
            transient=True,
            fingerprint="network_idle_close",
        )

    if "server closed the connection" in lowered:
        return TelegramDisconnectClassification(
            category="network_closed",
            message=message,
            transient=True,
            fingerprint="network_closed",
        )

    if "timeouterror" in lowered or "timed out" in lowered or "timeout" in lowered:
        return TelegramDisconnectClassification(
            category="timeout",
            message=message,
            transient=True,
            fingerprint="timeout",
        )

    if any(token in lowered for token in ("connection reset", "broken pipe", "connection aborted")):
        return TelegramDisconnectClassification(
            category="connection_reset",
            message=message,
            transient=True,
            fingerprint="connection_reset",
        )

    if "floodwait" in lowered or "flood wait" in lowered:
        return TelegramDisconnectClassification(
            category="rate_limited",
            message=message,
            transient=False,
            fingerprint="rate_limited",
        )

    return TelegramDisconnectClassification(
        category="unknown",
        message=message,
        transient=False,
        fingerprint=f"unknown:{lowered[:120]}",
    )


class ThrottledErrorLogger:
    def __init__(self, window_seconds: float = 60.0):
        self.window_seconds = max(1.0, float(window_seconds))
        self._records: Dict[Tuple[str, str], Dict[str, float]] = {}

    def log(self, account_id: str, context: str, error: object) -> TelegramDisconnectClassification:
        classified = classify_disconnect_error(error)
        key = (account_id, classified.fingerprint)
        now = time.time()
        record = self._records.get(key)

        if record and now - record["last_ts"] < self.window_seconds:
            record["suppressed"] += 1
            record["last_ts"] = now
            return classified

        suppressed = int(record["suppressed"]) if record else 0
        self._records[key] = {"last_ts": now, "suppressed": 0}

        message = (
            f"{context} | account={account_id} | category={classified.category} | "
            f"message={classified.message}"
        )
        if suppressed > 0:
            message += f" | suppressed={suppressed}"

        if classified.transient:
            logger.warning(message)
        else:
            logger.error(message)

        return classified

    def clear_account(self, account_id: str):
        stale_keys = [key for key in self._records if key[0] == account_id]
        for key in stale_keys:
            self._records.pop(key, None)
