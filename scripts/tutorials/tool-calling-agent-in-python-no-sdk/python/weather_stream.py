"""
Stream a stored prompt's reply token by token — plain Python, no SDK.

Same first step as `weather_agent.py` (render the stored prompt), but instead of
waiting for the whole completion we set `"stream": true` and read the gateway's
Server-Sent Events (SSE) stream: one `data:` frame per chunk, each carrying a
`choices[0].delta.content` string, terminated by `data: [DONE]`.

Streaming yields text deltas, so this example does NOT forward the prompt's tools:
if the model chose to call a tool, the first turn would stream tool-call fragments
instead of readable prose (streaming does not auto-run tools — the loop in
`weather_agent.py` is for that). Omitting `tools` keeps the streamed output clean.

Run:
  export ACRUXCORE_API_KEY=<your personal api key>
  export ACRUXCORE_BASE_URL=https://api.acruxcore.com/api/v1
  python weather_stream.py
"""

import json
import os

import requests

API_KEY = os.environ["ACRUXCORE_API_KEY"]
BASE_URL = os.environ["ACRUXCORE_BASE_URL"].rstrip("/")
HEADERS = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}


def render_prompt(name, alias, variables):
    r = requests.post(
        f"{BASE_URL}/prompts/{name}/{alias}/render",
        headers=HEADERS,
        json={"variables": variables},
    )
    r.raise_for_status()
    return r.json()


def main():
    rendered = render_prompt("py-weather-agent", "production", {"city": "Paris"})

    # `stream=True` on the request keeps the socket open so we can read frames as
    # they arrive; `"stream": true` in the body asks the gateway for SSE.
    resp = requests.post(
        f"{BASE_URL}/gateway/chat/completions",
        headers=HEADERS,
        json={"model": "gpt-4o-mini", "messages": rendered["messages"], "stream": True},
        stream=True,
    )
    resp.raise_for_status()

    full = ""
    for line in resp.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data: "):
            continue
        data = line[len("data: "):]
        if data == "[DONE]":
            break
        piece = json.loads(data)["choices"][0]["delta"].get("content", "")
        print(piece, end="", flush=True)  # render live
        full += piece

    print(f"\n\n(streamed {len(full)} characters)")


if __name__ == "__main__":
    main()
