"""Native Anthropic and Gemini wire formats for BYO (direct-provider) calls.

Every other part of the SDK speaks the OpenAI chat-completions shape: the body it
builds, the reply it reads, the chunks a stream yields, the messages a tool loop keeps.
This module is the one place that knows the two other shapes. It turns an OpenAI-shaped
body into an Anthropic Messages or Gemini ``generateContent`` request, and turns the
native reply (whole, or one streamed event at a time) back into OpenAI-shaped data. The
translation follows the gateway's own Anthropic and Gemini adapters, so a call made
through the gateway and the same call made BYO send the provider the same request.

Two things survive a round trip only because they are carried on the OpenAI-shaped tool
call: Gemini's call ``id`` and its ``thoughtSignature``. Gemini 3 models refuse a
follow-up turn whose function call has lost its signature, so it rides on the tool call
as ``extra_content.google.thought_signature`` (the same place Gemini's own
OpenAI-compatible endpoint puts it) and is sent back on the next turn.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from .errors import PROVIDER_ERROR, VALIDATION_ERROR, AcruxCoreError

#: Used when ``provider["kind"]`` is ``"anthropic"`` and no ``base_url`` is given.
ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
#: Used when ``provider["kind"]`` is ``"gemini"`` and no ``base_url`` is given.
GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

_ANTHROPIC_VERSION = "2023-06-01"
#: Anthropic requires ``max_tokens``. The gateway's Anthropic adapter uses the same
#: default, so a call without ``max_tokens=`` stops at the same length either way.
ANTHROPIC_DEFAULT_MAX_TOKENS = 1024

#: Anthropic has no ``response_format``; it is sent as one forced tool, as the gateway does.
_FORMAT_TOOL_DESCRIPTION = (
    "Return the final answer using this tool, matching its input schema exactly. "
    "Do not respond with plain text."
)
_FORMAT_TOOL_GENERIC_NAME = "structured_output"

#: OpenAI-body keys this module translates. Any other key came from ``extra_body`` and
#: is copied onto the native payload as it is, so a caller can still reach a native-only
#: field such as Anthropic's ``thinking`` or Gemini's ``safetySettings``.
_TRANSLATED_KEYS = frozenset({
    "model", "messages", "tools", "tool_choice", "response_format", "temperature",
    "max_tokens", "max_completion_tokens", "top_p", "stop", "stream", "stream_options",
    "reasoning_effort",
})

NativeKind = str  # "anthropic" | "gemini"


# ── shared helpers ─────────────────────────────────────────────────────────


def _content_text(content: Any) -> str:
    """The text of a message's content: the string itself, or its text parts joined."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    return "".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")


def _parse_data_url(url: str) -> Optional[Tuple[str, str]]:
    """``(media_type, base64_data)`` for a ``data:image/...;base64,`` URL, else ``None``."""
    if not url.startswith("data:") or ";base64," not in url:
        return None
    head, data = url[len("data:"):].split(";base64,", 1)
    return (head, data) if head.startswith("image/") else None


def _parse_args(arguments: Optional[str]) -> Any:
    """A tool call's JSON arguments, or ``{}`` when they do not parse."""
    try:
        return json.loads(arguments or "{}")
    except (TypeError, ValueError):
        return {}


def _output_limit(body: Dict[str, Any]) -> Optional[int]:
    """The output token limit, from ``max_tokens`` or OpenAI's newer
    ``max_completion_tokens`` (the SDK refuses a call that sets both)."""
    value = body.get("max_tokens")
    return value if value is not None else body.get("max_completion_tokens")


def _merge_passthrough(payload: Dict[str, Any], body: Dict[str, Any]) -> None:
    """Copy every key this module does not translate (``extra_body``) onto the payload.

    A dict value merges one level into a dict the translation already built, so
    ``extra_body={"generationConfig": {"thinkingConfig": ...}}`` adds to the
    ``generationConfig`` that ``temperature=`` filled instead of replacing it.

    :raises AcruxCoreError: ``VALIDATION_ERROR`` when an ``extra_body`` key would
        overwrite a value the translation set from a named argument.
    """
    for key, value in body.items():
        if key in _TRANSLATED_KEYS:
            continue
        if key not in payload:
            payload[key] = value
            continue
        existing = payload[key]
        if isinstance(existing, dict) and isinstance(value, dict):
            clash = sorted(k for k in value if k in existing)
            if clash:
                raise AcruxCoreError(
                    f"acruxcore: extra_body['{key}'] sets {', '.join(clash)}, which the SDK "
                    f"already sets from a named argument. Pass it once.",
                    VALIDATION_ERROR,
                )
            existing.update(value)
            continue
        raise AcruxCoreError(
            f"acruxcore: extra_body sets '{key}', which the SDK already sets from a named "
            f"argument. Pass it once.",
            VALIDATION_ERROR,
        )


def _openai_response(
    rid: str, model: str, text: str, tool_calls: List[Dict[str, Any]],
    finish_reason: Optional[str], usage: Dict[str, Any],
) -> Dict[str, Any]:
    """An OpenAI ``chat.completion`` body, the shape the rest of the SDK reads."""
    message: Dict[str, Any] = {"role": "assistant", "content": text}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": rid,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
        "usage": usage,
    }


def _openai_usage(prompt: int, completion: int, total: Optional[int] = None,
                  cached: int = 0, reasoning: int = 0) -> Dict[str, Any]:
    """OpenAI-shaped usage, with the cached and reasoning counts in their nested places."""
    usage: Dict[str, Any] = {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total if total is not None else prompt + completion,
    }
    if cached > 0:
        usage["prompt_tokens_details"] = {"cached_tokens": cached}
    if reasoning > 0:
        usage["completion_tokens_details"] = {"reasoning_tokens": reasoning}
    return usage


def _chunk(rid: str, model: str, delta: Dict[str, Any], finish_reason: Optional[str] = None,
           usage: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """One OpenAI ``chat.completion.chunk``, the shape a BYO stream is read as."""
    chunk: Dict[str, Any] = {
        "id": rid, "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        chunk["usage"] = usage
    return chunk


# ── Anthropic ──────────────────────────────────────────────────────────────


def _anthropic_usage(u: Dict[str, Any], output_tokens: Optional[int] = None) -> Dict[str, Any]:
    """Anthropic's ``input_tokens`` leaves out cache reads and writes; OpenAI's
    ``prompt_tokens`` is the whole prompt, so the three are added back together."""
    read = u.get("cache_read_input_tokens") or 0
    written = u.get("cache_creation_input_tokens") or 0
    prompt = (u.get("input_tokens") or 0) + read + written
    completion = output_tokens if output_tokens is not None else (u.get("output_tokens") or 0)
    return _openai_usage(prompt, completion, cached=read)


def _anthropic_stop(stop: Optional[str]) -> Optional[str]:
    return {"end_turn": "stop", "stop_sequence": "stop", "max_tokens": "length",
            "tool_use": "tool_calls"}.get(stop or "", stop) if stop else None


def _anthropic_blocks(content: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    blocks: List[Dict[str, Any]] = []
    for part in content:
        if part.get("type") == "text":
            blocks.append({"type": "text", "text": part.get("text", "")})
        elif part.get("type") == "image_url":
            url = (part.get("image_url") or {}).get("url", "")
            data = _parse_data_url(url)
            source = ({"type": "base64", "media_type": data[0], "data": data[1]} if data
                      else {"type": "url", "url": url})
            blocks.append({"type": "image", "source": source})
    return blocks


def _with_cache(m: Dict[str, Any], blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if m.get("cache_control") and blocks:
        blocks[-1]["cache_control"] = m["cache_control"]
    return blocks


def _anthropic_system(messages: List[Dict[str, Any]]) -> Any:
    system = [m for m in messages if m.get("role") == "system"]
    if any(m.get("cache_control") for m in system):
        return [
            {"type": "text", "text": _content_text(m.get("content")),
             **({"cache_control": m["cache_control"]} if m.get("cache_control") else {})}
            for m in system
        ]
    text = "\n".join(_content_text(m.get("content")) for m in system)
    return text or None


def _anthropic_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """OpenAI messages to Anthropic's. A ``tool`` result becomes a ``tool_result`` block
    on a user turn, and consecutive results merge into one user turn, since Anthropic
    wants every result of a parallel call in the turn right after the call."""
    out: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        if role == "tool":
            block = {"type": "tool_result", "tool_use_id": m.get("tool_call_id", ""),
                     "content": _content_text(m.get("content"))}
            blocks = _with_cache(m, [block])
            prev = out[-1] if out else None
            if (prev and prev["role"] == "user" and isinstance(prev["content"], list)
                    and prev["content"] and prev["content"][0].get("type") == "tool_result"):
                prev["content"].extend(blocks)
            else:
                out.append({"role": "user", "content": blocks})
            continue
        if role == "assistant" and m.get("tool_calls"):
            blocks = []
            text = _content_text(m.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            # Thinking blocks go first, unchanged: Anthropic refuses a tool loop turn with
            # thinking on whose tool_use lost them. They ride on a call's extra_content.
            for tc in m["tool_calls"]:
                blocks[:0] = _thinking_of(tc)
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                blocks.append({"type": "tool_use", "id": tc.get("id", ""), "name": fn.get("name", ""),
                               "input": _parse_args(fn.get("arguments"))})
            out.append({"role": "assistant", "content": _with_cache(m, blocks)})
            continue
        native_role = "assistant" if role == "assistant" else "user"
        content = m.get("content")
        if isinstance(content, list):
            out.append({"role": native_role, "content": _with_cache(m, _anthropic_blocks(content))})
        elif m.get("cache_control"):
            out.append({"role": native_role, "content": _with_cache(m, [{"type": "text", "text": content or ""}])})
        else:
            out.append({"role": native_role, "content": content or ""})
    return out


def _thinking_of(tool_call: Dict[str, Any]) -> List[Dict[str, Any]]:
    anthropic = (tool_call.get("extra_content") or {}).get("anthropic") or {}
    return list(anthropic.get("thinking_blocks") or [])


def _with_thinking(call: Dict[str, Any], thinking: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Put a turn's thinking blocks on its first tool call, where the next request reads
    them back from (the same place a Gemini thought signature rides)."""
    if thinking:
        call["extra_content"] = {"anthropic": {"thinking_blocks": thinking}}
    return call


_THINKING_TYPES = ("thinking", "redacted_thinking")


def _anthropic_format_tool(response_format: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not response_format or response_format.get("type") == "text":
        return None
    if response_format.get("type") == "json_schema":
        js = response_format.get("json_schema") or {}
        return {"name": js.get("name") or _FORMAT_TOOL_GENERIC_NAME,
                "input_schema": js.get("schema") or {"type": "object"}}
    return {"name": _FORMAT_TOOL_GENERIC_NAME, "input_schema": {"type": "object"}}


def _anthropic_payload(body: Dict[str, Any], stream: bool) -> Tuple[Dict[str, Any], Optional[str]]:
    messages = body.get("messages") or []
    payload: Dict[str, Any] = {
        "model": body["model"],
        "messages": _anthropic_messages(messages),
        "max_tokens": _output_limit(body) or ANTHROPIC_DEFAULT_MAX_TOKENS,
    }
    system = _anthropic_system(messages)
    if system:
        payload["system"] = system
    if body.get("temperature") is not None:
        payload["temperature"] = body["temperature"]
    if body.get("top_p") is not None:
        payload["top_p"] = body["top_p"]
    if body.get("stop") is not None:
        payload["stop_sequences"] = body["stop"] if isinstance(body["stop"], list) else [body["stop"]]
    if stream:
        payload["stream"] = True

    format_tool = _anthropic_format_tool(body.get("response_format"))
    tool_choice = body.get("tool_choice")
    if format_tool:
        if body.get("tools"):
            raise AcruxCoreError(
                "acruxcore: an Anthropic BYO call cannot take response_format together with "
                "tools — Anthropic has no response_format, and the SDK sends it as a forced "
                "tool call. Ask for the final answer as a tool call instead.",
                VALIDATION_ERROR,
            )
        payload["tools"] = [{**format_tool, "description": _FORMAT_TOOL_DESCRIPTION}]
        payload["tool_choice"] = {"type": "tool", "name": format_tool["name"]}
    elif body.get("tools") and tool_choice != "none":
        payload["tools"] = [
            {"name": t["function"]["name"],
             **({"description": t["function"]["description"]} if t["function"].get("description") else {}),
             "input_schema": t["function"].get("parameters") or {"type": "object", "properties": {}}}
            for t in body["tools"]
        ]
        if tool_choice == "auto":
            payload["tool_choice"] = {"type": "auto"}
        elif tool_choice == "required":
            payload["tool_choice"] = {"type": "any"}
        elif isinstance(tool_choice, dict):
            payload["tool_choice"] = {"type": "tool", "name": tool_choice["function"]["name"]}
    _merge_passthrough(payload, body)
    return payload, (format_tool["name"] if format_tool else None)


def _anthropic_response(data: Dict[str, Any], format_tool: Optional[str]) -> Dict[str, Any]:
    blocks = data.get("content") or []
    usage = _anthropic_usage(data.get("usage") or {})
    if format_tool:
        block = next((b for b in blocks if b.get("type") == "tool_use" and b.get("name") == format_tool), None)
        if block is not None:
            return _openai_response(data["id"], data["model"], json.dumps(block.get("input") or {}),
                                    [], "stop", usage)
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    calls = [
        {"id": b.get("id", ""), "type": "function",
         "function": {"name": b.get("name", ""), "arguments": json.dumps(b.get("input") or {})}}
        for b in blocks if b.get("type") == "tool_use"
    ]
    if calls:
        _with_thinking(calls[0], [b for b in blocks if b.get("type") in _THINKING_TYPES])
    return _openai_response(data["id"], data["model"], text, calls,
                            _anthropic_stop(data.get("stop_reason")), usage)


class _AnthropicStream:
    """Turns Anthropic's streamed events into OpenAI chunks, one event at a time.

    Anthropic numbers content blocks, text and tool_use in one sequence; OpenAI numbers
    tool calls on their own. The block index is mapped to a tool-call ordinal so
    ``index`` means "which parallel call" whichever provider produced it.
    """

    def __init__(self, model: str, format_tool: Optional[str]) -> None:
        self.id = f"msg_{uuid.uuid4().hex}"
        self.model = model
        self.format_tool = format_tool
        self.prompt_usage: Dict[str, Any] = {}
        self.ordinal_by_block: Dict[int, int] = {}
        self.format_blocks: set = set()
        self.suppressed = ""
        self.saw_format_block = False
        self.thinking: List[Dict[str, Any]] = []
        self.thinking_by_block: Dict[int, Dict[str, Any]] = {}
        self.done = False

    def feed(self, event: Dict[str, Any]) -> List[Dict[str, Any]]:
        etype = event.get("type")
        index = event.get("index")
        if etype == "error":
            err = event.get("error") or {}
            raise AcruxCoreError(
                f"acruxcore: Anthropic stream ended with an error — {err.get('message') or err}",
                PROVIDER_ERROR, body=event,
            )
        if etype == "message_start":
            msg = event.get("message") or {}
            self.id = msg.get("id") or self.id
            self.model = msg.get("model") or self.model
            self.prompt_usage = msg.get("usage") or {}
            return []
        if etype == "content_block_start":
            block = event.get("content_block") or {}
            if block.get("type") in _THINKING_TYPES:
                kept = dict(block)
                self.thinking.append(kept)
                self.thinking_by_block[index] = kept
                return []
            if block.get("type") != "tool_use":
                return []
            if self.format_tool and block.get("name") == self.format_tool:
                self.format_blocks.add(index)
                self.saw_format_block = True
                return []
            ordinal = len(self.ordinal_by_block)
            self.ordinal_by_block[index] = ordinal
            call = {"index": ordinal, "id": block.get("id", ""), "type": "function",
                    "function": {"name": block.get("name", ""), "arguments": ""}}
            if ordinal == 0:
                _with_thinking(call, self.thinking)
            return [_chunk(self.id, self.model, {"tool_calls": [call]})]
        if etype == "content_block_delta":
            delta = event.get("delta") or {}
            kept = self.thinking_by_block.get(index)
            if kept is not None:
                if delta.get("type") == "thinking_delta":
                    kept["thinking"] = kept.get("thinking", "") + (delta.get("thinking") or "")
                elif delta.get("type") == "signature_delta":
                    kept["signature"] = kept.get("signature", "") + (delta.get("signature") or "")
                return []
            if delta.get("type") == "text_delta" and delta.get("text"):
                if self.format_tool:
                    self.suppressed += delta["text"]
                    return []
                return [_chunk(self.id, self.model, {"content": delta["text"]})]
            if delta.get("type") == "input_json_delta":
                part = delta.get("partial_json") or ""
                if index in self.format_blocks:
                    return [_chunk(self.id, self.model, {"content": part})] if part else []
                if index in self.ordinal_by_block and part:
                    return [_chunk(self.id, self.model, {"tool_calls": [{
                        "index": self.ordinal_by_block[index], "function": {"arguments": part},
                    }]})]
            return []
        if etype == "message_delta":
            out: List[Dict[str, Any]] = []
            if self.format_tool and not self.saw_format_block and self.suppressed:
                out.append(_chunk(self.id, self.model, {"content": self.suppressed}))
                self.suppressed = ""
            finish = _anthropic_stop((event.get("delta") or {}).get("stop_reason"))
            if self.format_tool and finish == "tool_calls":
                finish = "stop"
            output_tokens = (event.get("usage") or {}).get("output_tokens")
            out.append(_chunk(self.id, self.model, {}, finish,
                              _anthropic_usage(self.prompt_usage, output_tokens)))
            return out
        if etype == "message_stop":
            self.done = True
        return []


# ── Gemini ─────────────────────────────────────────────────────────────────


def _gemini_part(part: Dict[str, Any]) -> Dict[str, Any]:
    if part.get("type") == "text":
        return {"text": part.get("text", "")}
    url = (part.get("image_url") or {}).get("url", "")
    data = _parse_data_url(url)
    if data is None:
        raise AcruxCoreError(
            "acruxcore: Gemini reads an image only as a data:image/...;base64 URL; send the "
            "image bytes inline instead of a link.",
            VALIDATION_ERROR,
        )
    return {"inlineData": {"mimeType": data[0], "data": data[1]}}


def _signature_of(tool_call: Dict[str, Any]) -> Optional[str]:
    google = ((tool_call.get("extra_content") or {}).get("google") or {})
    return google.get("thought_signature")


def _gemini_contents(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """OpenAI messages to Gemini ``contents``. A ``tool`` result becomes a
    ``functionResponse``, which Gemini keys by function name, so the name is looked up
    from the assistant turn that made the call. Consecutive results merge into one turn,
    as Gemini wants every response of a parallel call together."""
    names: Dict[str, str] = {}
    out: List[Dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        if role == "system":
            continue
        if role == "tool":
            call_id = m.get("tool_call_id", "")
            text = _content_text(m.get("content"))
            try:
                response = json.loads(text) if text else {}
            except ValueError:
                response = {"result": text}
            if not isinstance(response, dict):
                response = {"result": response}
            fr: Dict[str, Any] = {"name": names.get(call_id, call_id), "response": response}
            if call_id and call_id in names and not call_id.startswith("acx_"):
                fr["id"] = call_id
            part = {"functionResponse": fr}
            prev = out[-1] if out else None
            if prev and prev["role"] == "user" and prev["parts"] and "functionResponse" in prev["parts"][0]:
                prev["parts"].append(part)
            else:
                out.append({"role": "user", "parts": [part]})
            continue
        if role == "assistant" and m.get("tool_calls"):
            parts: List[Dict[str, Any]] = []
            text = _content_text(m.get("content"))
            if text:
                parts.append({"text": text})
            for tc in m["tool_calls"]:
                fn = tc.get("function") or {}
                name = fn.get("name", "")
                call_id = tc.get("id") or ""
                if call_id:
                    names[call_id] = name
                call: Dict[str, Any] = {"name": name, "args": _parse_args(fn.get("arguments"))}
                # An id the SDK made up (Gemini sent none) means nothing to Gemini.
                if call_id and not call_id.startswith("acx_"):
                    call["id"] = call_id
                fc_part: Dict[str, Any] = {"functionCall": call}
                signature = _signature_of(tc)
                if signature:
                    fc_part["thoughtSignature"] = signature
                parts.append(fc_part)
            out.append({"role": "model", "parts": parts})
            continue
        native_role = "model" if role == "assistant" else "user"
        content = m.get("content")
        if isinstance(content, list):
            out.append({"role": native_role, "parts": [_gemini_part(p) for p in content]})
        else:
            out.append({"role": native_role, "parts": [{"text": content or ""}]})
    return out


def _gemini_payload(body: Dict[str, Any]) -> Dict[str, Any]:
    messages = body.get("messages") or []
    payload: Dict[str, Any] = {"contents": _gemini_contents(messages)}
    system = "\n".join(_content_text(m.get("content")) for m in messages if m.get("role") == "system")
    if system:
        payload["systemInstruction"] = {"parts": [{"text": system}]}
    config: Dict[str, Any] = {}
    if body.get("temperature") is not None:
        config["temperature"] = body["temperature"]
    if _output_limit(body) is not None:
        config["maxOutputTokens"] = _output_limit(body)
    if body.get("top_p") is not None:
        config["topP"] = body["top_p"]
    if body.get("stop") is not None:
        config["stopSequences"] = body["stop"] if isinstance(body["stop"], list) else [body["stop"]]
    rf = body.get("response_format")
    if rf and rf.get("type") != "text":
        config["responseMimeType"] = "application/json"
        schema = (rf.get("json_schema") or {}).get("schema") if rf.get("type") == "json_schema" else None
        if schema:
            # The full-JSON-Schema field, not the older OpenAPI-subset `responseSchema`,
            # so a pydantic schema with `$defs` and `title` is taken as it is.
            config["responseJsonSchema"] = schema
    if config:
        payload["generationConfig"] = config
    tool_choice = body.get("tool_choice")
    if body.get("tools") and tool_choice != "none":
        payload["tools"] = [{"functionDeclarations": [
            {"name": t["function"]["name"],
             **({"description": t["function"]["description"]} if t["function"].get("description") else {}),
             # The full-JSON-Schema field: `parameters` is an OpenAPI subset that rejects
             # `additionalProperties`, which zod and pydantic schemas carry.
             "parametersJsonSchema": t["function"].get("parameters") or {"type": "object", "properties": {}}}
            for t in body["tools"]
        ]}]
        if tool_choice == "auto":
            payload["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
        elif tool_choice == "required":
            payload["toolConfig"] = {"functionCallingConfig": {"mode": "ANY"}}
        elif isinstance(tool_choice, dict):
            payload["toolConfig"] = {"functionCallingConfig": {
                "mode": "ANY", "allowedFunctionNames": [tool_choice["function"]["name"]]}}
    _merge_passthrough(payload, body)
    return payload


def _gemini_usage(meta: Dict[str, Any]) -> Dict[str, Any]:
    """Gemini counts thinking apart from the answer and bills it as output; OpenAI
    counts it inside ``completion_tokens``, so the two are added."""
    prompt = meta.get("promptTokenCount") or 0
    thoughts = meta.get("thoughtsTokenCount") or 0
    completion = (meta.get("candidatesTokenCount") or 0) + thoughts
    return _openai_usage(prompt, completion, meta.get("totalTokenCount") or prompt + completion,
                         cached=meta.get("cachedContentTokenCount") or 0, reasoning=thoughts)


def _gemini_finish(reason: Optional[str]) -> Optional[str]:
    if reason is None:
        return None
    if reason == "MAX_TOKENS":
        return "length"
    if reason in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"):
        return "content_filter"
    return "stop"


def _gemini_tool_call(part: Dict[str, Any]) -> Dict[str, Any]:
    fc = part["functionCall"]
    call: Dict[str, Any] = {
        "id": fc.get("id") or f"acx_{uuid.uuid4().hex[:24]}",
        "type": "function",
        "function": {"name": fc.get("name", ""), "arguments": json.dumps(fc.get("args") or {})},
    }
    if part.get("thoughtSignature"):
        call["extra_content"] = {"google": {"thought_signature": part["thoughtSignature"]}}
    return call


def _gemini_text(parts: List[Dict[str, Any]]) -> str:
    # A thought summary (`thought: true`) is the model's reasoning, not its answer.
    return "".join(p["text"] for p in parts if isinstance(p.get("text"), str) and not p.get("thought"))


def _gemini_response(data: Dict[str, Any], model: str) -> Dict[str, Any]:
    candidates = data.get("candidates") or []
    if not candidates:
        feedback = data.get("promptFeedback") or {}
        raise AcruxCoreError(
            f"acruxcore: Gemini returned no answer"
            f"{' — prompt blocked: ' + feedback['blockReason'] if feedback.get('blockReason') else ''}.",
            PROVIDER_ERROR, body=data,
        )
    candidate = candidates[0]
    parts = (candidate.get("content") or {}).get("parts") or []
    calls = [_gemini_tool_call(p) for p in parts if p.get("functionCall")]
    finish = "tool_calls" if calls else _gemini_finish(candidate.get("finishReason"))
    return _openai_response(data.get("responseId") or f"gemini-{uuid.uuid4().hex}",
                            data.get("modelVersion") or model, _gemini_text(parts), calls, finish,
                            _gemini_usage(data.get("usageMetadata") or {}))


class _GeminiStream:
    """Turns Gemini's streamed frames into OpenAI chunks. Gemini sends each function
    call whole, in one frame, so each becomes one complete tool-call delta."""

    def __init__(self, model: str) -> None:
        self.id = f"gemini-{uuid.uuid4().hex}"
        self.model = model
        self.calls = 0
        self.done = False

    def feed(self, frame: Dict[str, Any]) -> List[Dict[str, Any]]:
        if frame.get("error"):
            err = frame["error"]
            raise AcruxCoreError(
                f"acruxcore: Gemini stream ended with an error — {err.get('message') or err}",
                PROVIDER_ERROR, body=frame,
            )
        self.id = frame.get("responseId") or self.id
        self.model = frame.get("modelVersion") or self.model
        candidate = (frame.get("candidates") or [{}])[0]
        parts = (candidate.get("content") or {}).get("parts") or []
        delta: Dict[str, Any] = {}
        text = _gemini_text(parts)
        if text:
            delta["content"] = text
        tool_calls = []
        for part in parts:
            if part.get("functionCall"):
                tool_calls.append({"index": self.calls, **_gemini_tool_call(part)})
                self.calls += 1
        if tool_calls:
            delta["tool_calls"] = tool_calls
        reason = candidate.get("finishReason")
        finish = None
        if reason is not None:
            finish = "tool_calls" if self.calls else _gemini_finish(reason)
        usage = _gemini_usage(frame["usageMetadata"]) if frame.get("usageMetadata") and reason else None
        if not delta and finish is None and usage is None:
            return []
        return [_chunk(self.id, self.model, delta, finish, usage)]


# ── public entry points ────────────────────────────────────────────────────


def native_request(
    kind: NativeKind, base_url: str, api_key: str, body: Dict[str, Any], stream: bool,
) -> Tuple[str, Dict[str, str], Dict[str, Any], Optional[str]]:
    """Build the native request for one BYO call.

    :param kind: ``"anthropic"`` or ``"gemini"``.
    :param base_url: The provider's base URL, without a trailing slash.
    :param api_key: Sent as ``x-api-key`` (Anthropic) or ``x-goog-api-key`` (Gemini).
    :param body: The OpenAI-shaped body the SDK built, ``extra_body`` included.
    :param stream: Whether to ask for a stream.
    :returns: ``(url, headers, payload, format_tool)``. ``format_tool`` names the forced
        tool an Anthropic ``response_format`` became, to pass to the reply translation.
    :raises AcruxCoreError: ``VALIDATION_ERROR`` for a body the native API cannot take.
    """
    if kind == "anthropic":
        payload, format_tool = _anthropic_payload(body, stream)
        headers = {"x-api-key": api_key, "anthropic-version": _ANTHROPIC_VERSION,
                   "Content-Type": "application/json"}
        return f"{base_url}/messages", headers, payload, format_tool
    payload = _gemini_payload(body)
    method = "streamGenerateContent?alt=sse" if stream else "generateContent"
    model_path = body["model"] if body["model"].startswith("models/") else f"models/{body['model']}"
    headers = {"x-goog-api-key": api_key, "Content-Type": "application/json"}
    return f"{base_url}/{model_path}:{method}", headers, payload, None


def native_response(kind: NativeKind, data: Dict[str, Any], model: str,
                    format_tool: Optional[str]) -> Dict[str, Any]:
    """Translate a native (non-streamed) reply into an OpenAI ``chat.completion`` body.

    :raises AcruxCoreError: ``PROVIDER_ERROR`` when Gemini returns no candidate.
    """
    if kind == "anthropic":
        return _anthropic_response(data, format_tool)
    return _gemini_response(data, model)


def native_stream(kind: NativeKind, model: str, format_tool: Optional[str]) -> Any:
    """A stateful translator for one native stream. Its ``feed(event)`` takes one parsed
    SSE ``data`` object and returns the OpenAI chunks it becomes (often none); its
    ``done`` turns true once the provider has said the stream is complete."""
    if kind == "anthropic":
        return _AnthropicStream(model, format_tool)
    return _GeminiStream(model)
