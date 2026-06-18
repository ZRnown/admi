from telegram_bridge.client import parse_proxy_url


def test_parse_proxy_url_returns_none_for_empty_values():
    assert parse_proxy_url(None) is None
    assert parse_proxy_url("") is None
    assert parse_proxy_url("   ") is None


def test_parse_proxy_url_supports_socks5_url_with_auth():
    assert parse_proxy_url("socks5://user:pass@127.0.0.1:1080") == {
        "proxy_type": "socks5",
        "addr": "127.0.0.1",
        "port": 1080,
        "username": "user",
        "password": "pass",
        "rdns": True,
    }


def test_parse_proxy_url_supports_http_url_without_auth():
    assert parse_proxy_url("http://proxy.example.com:8080") == {
        "proxy_type": "http",
        "addr": "proxy.example.com",
        "port": 8080,
        "rdns": True,
    }
