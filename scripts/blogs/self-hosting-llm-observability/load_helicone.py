"""Helicone has no OTLP intake; it records requests, not span trees.

Send 1,000 request logs to its custom-log endpoint, each carrying the same
system prompt, user question and answer as the `llm-call` span in load.py.

  python load_helicone.py --base http://localhost:8585 --key sk-helicone-...
"""
import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

from load import ANSWER, SYSTEM, question


def body(n: int) -> dict:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    return {
        "providerRequest": {
            "url": "custom-model-nopath",
            "json": {"model": "gpt-4o-mini", "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": question(10000 + n)},
            ]},
            "meta": {},
        },
        "providerResponse": {
            "json": {
                "model": "gpt-4o-mini",
                "choices": [{"message": {"role": "assistant", "content": ANSWER.format(n=10000 + n)}}],
                "usage": {"prompt_tokens": 182, "completion_tokens": 61, "total_tokens": 243},
            },
            "status": 200,
            "headers": {},
        },
        "timing": {"startTime": now, "endTime": now},
    }


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--base", required=True)
    p.add_argument("--key", required=True)
    p.add_argument("--logs", type=int, default=1000)
    a = p.parse_args()
    s = requests.Session()
    url = f"{a.base}/v1/trace/custom/log/typed"
    hdr = {"Authorization": f"Bearer {a.key}"}

    def send(n: int) -> int:
        return s.post(url, json=body(n), headers=hdr, timeout=30).status_code

    t0 = time.time()
    with ThreadPoolExecutor(8) as ex:
        codes = list(ex.map(send, range(1, a.logs + 1)))
    print(json.dumps({"logs": a.logs, "ok": codes.count(200),
                      "non_200": {str(c): codes.count(c) for c in set(codes) if c != 200},
                      "seconds": round(time.time() - t0, 1)}))


if __name__ == "__main__":
    main()
