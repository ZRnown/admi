"""WaveSpeed 去水印客户端。"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

import aiohttp

WAVESPEED_ENDPOINT = "https://api.wavespeed.ai/api/v3/wavespeed-ai/image-watermark-remover"


def normalize_watermark_removal_config(raw: Any) -> Optional[Dict[str, Any]]:
    if not raw or not isinstance(raw, dict):
        return None
    api_key = str(raw.get("apiKey") or "").strip()
    mode = "ocr" if raw.get("mode") == "ocr" else "always"
    enabled = True if raw.get("enabled") is True else False if raw.get("enabled") is False else bool(api_key)
    if not enabled or not api_key:
        return None
    return {
        "enabled": True,
        "mode": mode,
        "apiKey": api_key,
    }


def extract_output_url(payload: Any) -> Optional[str]:
    candidates: list[str] = []

    def visit(value: Any, depth: int = 0) -> None:
        if depth > 5 or candidates:
            return
        if isinstance(value, str):
            if value.startswith(("http://", "https://")):
                candidates.append(value)
            return
        if isinstance(value, list):
            for item in value:
                visit(item, depth + 1)
                if candidates:
                    return
            return
        if isinstance(value, dict):
            for key in ("outputs", "output", "images", "image", "url", "result", "data"):
                if key in value:
                    visit(value.get(key), depth + 1)
                    if candidates:
                        return
            for item in value.values():
                visit(item, depth + 1)
                if candidates:
                    return

    visit(payload)
    return candidates[0] if candidates else None


async def remove_watermark_from_image_url(
    image_url: str,
    config: Any,
    session: aiohttp.ClientSession,
) -> str:
    effective = normalize_watermark_removal_config(config)
    if not effective or not image_url:
        return image_url

    async with session.post(
        WAVESPEED_ENDPOINT,
        headers={
            "Authorization": f"Bearer {effective['apiKey']}",
            "Content-Type": "application/json",
        },
        json={
            "enable_sync_mode": True,
            "enable_base64_output": False,
            "input": {
                "image": image_url,
            },
        },
    ) as response:
        raw = await response.text()
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"raw": raw}
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(
                f"WaveSpeed request failed {response.status}: {json.dumps(payload, ensure_ascii=False)[:280]}"
            )
        output_url = extract_output_url(payload)
        if not output_url:
            raise RuntimeError(
                f"WaveSpeed response missing output url: {json.dumps(payload, ensure_ascii=False)[:280]}"
            )
        return output_url
