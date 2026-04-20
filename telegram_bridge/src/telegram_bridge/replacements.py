import re
import unicodedata
from functools import lru_cache
from typing import Dict, Optional

COMMON_FORMAT_CHARS = "\u200b\u200c\u200d\u2060\ufeff"
COMMON_FORMAT_CHARS_CLASS = f"[{re.escape(COMMON_FORMAT_CHARS)}]*"


def _strip_format_chars(value: str) -> str:
    return "".join(ch for ch in str(value or "") if unicodedata.category(ch) != "Cf")


@lru_cache(maxsize=512)
def _build_replacement_pattern(source: str) -> Optional[re.Pattern[str]]:
    cleaned = _strip_format_chars(source)
    if not cleaned:
        return None

    parts = []
    for ch in cleaned:
        if ch.isspace():
            parts.append(r"\s+")
        else:
            parts.append(re.escape(ch))

    return re.compile(COMMON_FORMAT_CHARS_CLASS.join(parts), re.IGNORECASE)


def apply_replacements(value: Optional[str], replacements: Optional[Dict[str, str]]) -> Optional[str]:
    if not isinstance(value, str) or not replacements:
        return value

    result = value
    for old_text, new_text in replacements.items():
        pattern = _build_replacement_pattern(str(old_text or ""))
        if pattern is None:
            continue
        result = pattern.sub(str(new_text or ""), result)

    return result
