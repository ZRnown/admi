from telegram_bridge.wavespeed_watermark_remover import (
    extract_output_url,
    normalize_watermark_removal_config,
)


def test_normalize_watermark_removal_config_merges_expected_fields():
    assert normalize_watermark_removal_config({"enabled": True, "mode": "ocr", "apiKey": "ws-key"}) == {
        "enabled": True,
        "mode": "ocr",
        "apiKey": "ws-key",
    }


def test_normalize_watermark_removal_config_returns_none_without_key():
    assert normalize_watermark_removal_config({"enabled": False}) is None
    assert normalize_watermark_removal_config({}) is None


def test_extract_output_url_supports_multiple_shapes():
    assert extract_output_url({"outputs": ["https://cdn.example.com/a.png"]}) == "https://cdn.example.com/a.png"
    assert extract_output_url({"data": {"output": {"image": "https://cdn.example.com/b.png"}}}) == "https://cdn.example.com/b.png"
