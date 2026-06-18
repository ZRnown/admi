import asyncio
import json
import sys
from contextlib import aclosing
from pathlib import Path
from typing import Any, Dict, List

from twscrape import API


def _read_payload() -> Dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    return json.loads(raw)


def _tweet_to_dict(tweet: Any) -> Dict[str, Any]:
    if hasattr(tweet, "dict"):
        return tweet.dict()
    if isinstance(tweet, dict):
        return tweet
    return {
        "id": getattr(tweet, "id", None),
        "rawContent": getattr(tweet, "rawContent", "") or getattr(tweet, "text", ""),
        "user": getattr(tweet, "user", None),
    }


async def _collect(gen: Any, limit: int) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    async with aclosing(gen) as stream:
        async for tweet in stream:
            items.append(_tweet_to_dict(tweet))
            if len(items) >= limit:
                break
    return items


async def _run(payload: Dict[str, Any]) -> Dict[str, Any]:
    source_user_name = str(payload.get("sourceUserName") or "").strip().lstrip("@")
    source_user_id = str(payload.get("sourceUserId") or "").strip()
    if not source_user_name and not source_user_id:
        return {"success": False, "error": "missing sourceUserName or sourceUserId"}

    limit = int(payload.get("limit") or 10)
    limit = max(1, min(limit, 50))
    project_root = Path(__file__).resolve().parents[2]
    raw_db_path = str(payload.get("dbPath") or "").strip()
    db_path_obj = Path(raw_db_path) if raw_db_path else project_root / ".data/twscrape/accounts.db"
    if not db_path_obj.is_absolute():
        db_path_obj = project_root / db_path_obj
    db_path = str(db_path_obj)
    proxy_url = str(payload.get("proxyUrl") or "").strip() or None
    include_replies = payload.get("includeReplies") is True

    api = API(db_path, proxy=proxy_url, raise_when_no_account=True)

    user_id = source_user_id
    if source_user_name:
        user = await api.user_by_login(source_user_name)
        if user is None:
            return {"success": False, "error": f"user not found: {source_user_name}"}
        user_id = str(getattr(user, "id", "") or getattr(user, "id_str", "") or "")

    if not user_id:
        return {"success": False, "error": "missing resolved user id"}

    numeric_user_id = int(user_id)
    if include_replies:
        tweets = await _collect(api.user_tweets_and_replies(numeric_user_id, limit=limit), limit)
    else:
        tweets = await _collect(api.user_tweets(numeric_user_id, limit=limit), limit)

    return {"success": True, "tweets": tweets}


def main() -> None:
    try:
        payload = _read_payload()
        result = asyncio.run(_run(payload))
    except Exception as exc:
        result = {"success": False, "error": str(exc)}
    print(json.dumps(result, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
