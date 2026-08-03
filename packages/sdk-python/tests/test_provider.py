"""Unit tests for BYO provider name inference."""

import pytest

from acruxcore.provider import infer_provider_name


@pytest.mark.parametrize(
    "base_url,expected",
    [
        ("https://api.groq.com/openai/v1", "api.groq.com"),
        ("https://api.openai.com/v1", "api.openai.com"),
        ("https://api.together.xyz/v1", "api.together.xyz"),
        ("http://localhost:8000/v1", "localhost"),
        ("http://127.0.0.1:11434/v1", "127.0.0.1"),
        ("https://my-proxy.internal.company.com/v1", "my-proxy.internal.company.com"),
    ],
)
def test_infer_provider_name(base_url, expected):
    assert infer_provider_name(base_url) == expected
