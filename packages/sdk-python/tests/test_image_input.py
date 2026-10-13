"""A typed caller can send an image (issue #573).

``Message`` and ``PromptMessage`` take a list of text and image parts, and ``chat()``
passes the list to the gateway unchanged. Every test drives the real client through a
mocked httpx transport, so "sent unchanged" is an assertion about the request body.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import httpx
import pytest

from acruxcore import AcruxCore, ContentPart, Message
from acruxcore.types import PromptMessage

CONTENT: List[ContentPart] = [
    {"type": "text", "text": "Read this receipt. Reply with the merchant and the total."},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo=", "detail": "high"}},
]


@pytest.mark.asyncio
async def test_chat_sends_the_parts_as_given_and_returns_the_reply_as_text() -> None:
    sent: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-1",
                "model": "vision-gemma",
                "choices": [
                    {"index": 0, "message": {"role": "assistant", "content": "BLUE HERON CAFE 12.50"}, "finish_reason": "stop"}
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 4, "total_tokens": 9},
            },
        )

    hub = AcruxCore(api_key="k", base_url="http://localhost:3001/api/v1", transport=httpx.MockTransport(handler))
    message: Message = {"role": "user", "content": CONTENT}
    try:
        result = await hub.gateway.chat(model="vision-gemma", messages=[message])
    finally:
        await hub.aclose()

    assert sent[0]["messages"][0]["content"] == CONTENT
    assert result.content == "BLUE HERON CAFE 12.50"


def test_a_stored_prompt_message_can_hold_an_image_link_template() -> None:
    stored: PromptMessage = {
        "role": "user",
        "content": [
            {"type": "text", "text": "Read this {{ kind }}."},
            {"type": "image_url", "image_url": {"url": "{{ receipt_url }}"}},
        ],
    }

    assert isinstance(stored["content"], list)


def test_image_url_requires_url_and_leaves_detail_optional() -> None:
    from acruxcore.types import ImageUrl

    # A type checker reads these sets: an image with no `url` must not type-check.
    assert ImageUrl.__required_keys__ == frozenset({"url"})
    assert ImageUrl.__optional_keys__ == frozenset({"detail"})
