"""Unit tests for prompt overrides, ``compare_local`` and the judge scorer.

The real client runs end to end; only the HTTP boundary is replaced, by an in-memory
stand-in that serves several local runs at once, the render and version-lookup
endpoints, the judge endpoint and the candidate commit. Each test asserts on what the
server was sent. The live run against a real server is the tutorial script under
``scripts/tutorials/improve-a-rag-agent-from-feedback``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any, Dict, List
from urllib.parse import parse_qs

import httpx
import pytest

from acruxcore import AcruxCore, AcruxCoreError, LocalComparison, LocalExample, pin_prompts, pinned_version

TEMPLATES = {1: "production template", 7: "candidate template"}


class FakeServer:
    """Serves local runs (any number), render, ``/prompt-versions``, judge and commit."""

    def __init__(self, examples: int = 2, ignores_pin: bool = False) -> None:
        # ignores_pin: a server from before pinned renders, which drops the unknown
        # `version` key and renders the alias's version instead.
        self.ignores_pin = ignores_pin
        self.examples = [
            {"id": str(uuid.uuid4()), "input": {"q": f"question {i}"}, "criteria": f"rule {i}",
             "expected": None, "history": None}
            for i in range(examples)
        ]
        self.runs: Dict[str, Dict[str, Any]] = {}
        self.renders: List[Dict[str, Any]] = []
        self.version_queries: List[Dict[str, List[str]]] = []
        self.judge_calls: List[Dict[str, Any]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        path = request.url.path.replace("/api/v1", "", 1)
        if path == "/experiments/local":
            run_id = str(uuid.uuid4())
            self.runs[run_id] = {"created": body, "stored": {}, "status": "running"}
            return httpx.Response(201, json={
                "experiment_id": f"exp-{run_id}", "run_id": run_id, "cell_key": f"{body['name']}|local",
                "url": f"http://app/evaluations/runs/{run_id}", "examples": self.examples,
            })
        if path == "/traces":
            return httpx.Response(201, json={"traceIds": [t["traceId"] for t in body["traces"]]})
        if path.endswith("/render"):
            self.renders.append({"path": path, **body})
            version = 1 if self.ignores_pin else body.get("version", 1)
            if version not in TEMPLATES:
                return httpx.Response(404, json={"error": {
                    "code": "NOT_FOUND", "message": f'Version {version} not found for prompt "support-agent"',
                }})
            return httpx.Response(200, json={
                "messages": [{"role": "system", "content": TEMPLATES[version]}],
                "tools": [], "toolResolutions": [], "model": None,
                "versionId": f"v{version}-id", "versionNumber": version,
            })
        if path == "/prompt-versions":
            query = parse_qs(request.url.query.decode())
            self.version_queries.append(query)
            version = 1 if self.ignores_pin or "version" not in query else int(query["version"][0])
            return httpx.Response(200, json={
                "id": f"v{version}-id", "promptId": "p1", "versionNumber": version,
                "messages": [{"role": "system", "content": TEMPLATES[version]}], "variables": [],
                "model": None, "createdBy": "u", "createdAt": "2026-10-26T00:00:00Z",
            })
        if path.startswith("/runs/") and path.endswith("/judge"):
            self.judge_calls.append({"run_id": path.split("/")[2], **body})
            passed = "candidate" in json.dumps(body["output"])
            return httpx.Response(200, json={
                "score": 90 if passed else 20, "passed": passed,
                "reason": "follows the rule" if passed else "ignores the rule",
                "judge_trace_id": str(uuid.uuid4()),
            })
        if path.startswith("/runs/") and path.endswith("/commit"):
            return httpx.Response(201, json={
                "promptName": "support-agent", "created": True,
                "version": {"id": "v7-id", "versionNumber": 7, "messages": []},
            })
        if path.startswith("/runs/") and path.endswith("/results"):
            run = self.runs[path.split("/")[2]]
            for r in body["results"]:
                run["stored"][r["example_id"]] = r
            return httpx.Response(200, json={"written": len(body["results"]),
                                             "completed": len(run["stored"]), "total": len(self.examples)})
        if path.startswith("/runs/") and path.endswith("/finish"):
            run = self.runs[path.split("/")[2]]
            run["status"] = "succeeded"
            return httpx.Response(200, json={"id": path.split("/")[2], "status": "succeeded"})
        return httpx.Response(404, json={"error": {"message": f"no route {path}"}})

    def client(self) -> AcruxCore:
        return AcruxCore(api_key="test-key", base_url="http://localhost:3000/api/v1",
                         transport=httpx.MockTransport(self.handler), max_retries=0, retry_interval=1)

    def run_named(self, name: str) -> Dict[str, Any]:
        return next(r for r in self.runs.values() if r["created"]["name"] == name)


async def test_pin_prompts_renders_the_pinned_version_and_caches_it_apart() -> None:
    server = FakeServer()
    async with server.client() as hub:
        plain = await hub.prompts.render("support-agent", "production", {"q": "x"})
        with pin_prompts({"support-agent": 7}):
            pinned = await hub.prompts.render("support-agent", "production", {"q": "x"})
            other = await hub.prompts.render("other-prompt", "production", {"q": "x"})
        after = await hub.prompts.render("support-agent", "production", {"q": "x"})

    assert plain.messages[0]["content"] == "production template"
    assert pinned.messages[0]["content"] == "candidate template" and pinned.version_number == 7
    assert "version" not in server.renders[-1]  # only the pinned name is pinned
    assert other.version_number == 1
    # The unpinned entry was cached before the pin and is served again after it,
    # and the pinned render never replaced it.
    assert after.messages[0]["content"] == "production template"
    assert [r.get("version") for r in server.renders] == [None, 7, None]


async def test_a_pinned_render_the_server_did_not_honour_raises_instead_of_running_the_alias() -> None:
    server = FakeServer(ignores_pin=True)
    async with server.client() as hub:
        with pin_prompts({"support-agent": 7}):
            with pytest.raises(AcruxCoreError, match="pinned to version 7") as caught:
                await hub.prompts.render("support-agent", "production", {"q": "old server"})
            # Nothing was cached, so a retry asks the server again.
            with pytest.raises(AcruxCoreError):
                await hub.prompts.render("support-agent", "production", {"q": "old server"})

    assert caught.value.code == "API_ERROR"
    assert [r.get("version") for r in server.renders] == [7, 7]


async def test_a_pinned_version_that_does_not_exist_names_the_server_reason() -> None:
    server = FakeServer()
    async with server.client() as hub:
        with pin_prompts({"support-agent": 999}):
            with pytest.raises(AcruxCoreError, match="Version 999 not found") as caught:
                await hub.prompts.render("support-agent", "production", {"q": "x"})

    assert caught.value.status_code == 404


async def test_get_by_alias_asks_for_the_pinned_version_by_number_still_naming_the_alias() -> None:
    server = FakeServer()
    async with server.client() as hub:
        with pin_prompts({"support-agent": 7}):
            version = await hub.prompts.get_by_alias("support-agent", "production")
        unpinned = await hub.prompts.get_by_alias("support-agent", "production")

    assert version.version_number == 7
    # The alias goes too, so the server refuses a misspelled one as render does.
    assert server.version_queries[0] == {"name": ["support-agent"], "alias": ["production"], "version": ["7"]}
    assert unpinned.version_number == 1
    assert server.version_queries[1] == {"name": ["support-agent"], "alias": ["production"]}


async def test_a_pinned_get_by_alias_the_server_did_not_honour_raises() -> None:
    server = FakeServer(ignores_pin=True)
    async with server.client() as hub:
        with pin_prompts({"support-agent": 7}):
            with pytest.raises(AcruxCoreError, match="pinned to version 7") as caught:
                await hub.prompts.get_by_alias("support-agent", "production")
    assert caught.value.code == "API_ERROR"


def test_pin_prompts_rejects_a_version_that_is_not_a_number() -> None:
    with pytest.raises(ValueError, match="must be a version number"):
        with pin_prompts({"support-agent": "seven"}):  # type: ignore[dict-item]
            pass


async def test_compare_local_runs_variants_side_by_side_with_their_own_pins() -> None:
    server = FakeServer(examples=3)
    in_flight = 0
    peak = 0

    async def agent(inp: Dict[str, Any], ctx: LocalExample) -> str:
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        rendered = await hub.prompts.render("support-agent", "production", {"q": inp["q"]})
        await asyncio.sleep(0.01)
        in_flight -= 1
        return rendered.messages[0]["content"]

    async with server.client() as hub:
        comparison = await hub.experiments.compare_local(
            "ds-1",
            task=agent,
            scorers=[hub.experiments.judge("gpt-4o-mini")],
            variants={"production": None, "candidate-B": {"support-agent": 7}},
            metadata={"git_sha": "abc"},
        )

    assert isinstance(comparison, LocalComparison)
    assert list(comparison.runs) == ["production", "candidate-B"]
    base = server.run_named("production")
    cand = server.run_named("candidate-B")
    # Each run's outputs came from its own pin, though both ran at once on one client.
    assert {r["output"] for r in base["stored"].values()} == {"production template"}
    assert {r["output"] for r in cand["stored"].values()} == {"candidate template"}
    assert peak > 1
    # The pins are recorded on the run, next to the caller's own metadata.
    assert cand["created"]["metadata"] == {"git_sha": "abc", "prompt_overrides": {"support-agent": 7}}
    assert base["created"]["metadata"] == {"git_sha": "abc"}
    # The judge scorer called each output's own run, and its 0–100 became 0–1.
    for run_id, run in server.runs.items():
        calls = [c for c in server.judge_calls if c["run_id"] == run_id]
        assert {c["example_id"] for c in calls} == set(run["stored"])
        assert all(c["model"] == "gpt-4o-mini" for c in calls)
    assert {r["scores"][0]["score"] for r in cand["stored"].values()} == {90.0}
    assert {r["scores"][0]["passed"] for r in base["stored"].values()} == {False}
    assert comparison.runs["candidate-B"].summary["judge"].pass_rate == 1.0
    cand_id = comparison.runs["candidate-B"].run_id
    assert comparison.compare_urls == {
        "candidate-B": f"{comparison.runs['production'].url}/compare?target_run={cand_id}"
    }
    table = comparison.format()
    assert "judge" in table and "0%" in table and "100%" in table


async def test_judge_scorer_called_outside_a_local_run_says_so() -> None:
    server = FakeServer()
    async with server.client() as hub:
        judge = hub.experiments.judge("gpt-4o-mini")
        with pytest.raises(RuntimeError, match="only works inside experiments.run_local"):
            await judge(output="x", example=LocalExample(id="e", input={}, expected=None,
                                                         criteria=None, trace_id="t"))


async def test_commit_candidate_returns_what_to_pin() -> None:
    server = FakeServer()
    async with server.client() as hub:
        result = await hub.runs.commit_candidate("run-1", "cand-1")
    assert (result.prompt_name, result.version_number, result.created) == ("support-agent", 7, True)


def test_compare_local_needs_a_variant() -> None:
    async def run() -> None:
        async with FakeServer().client() as hub:
            await hub.experiments.compare_local("ds", task=lambda x: x, variants={})

    with pytest.raises(ValueError, match="at least one variant"):
        asyncio.run(run())


async def test_judge_sends_the_judge_prompt_version_it_is_given() -> None:
    server = FakeServer(examples=2)

    async def agent(inp: Dict[str, Any], ctx: LocalExample) -> str:
        return (await hub.prompts.render("support-agent", "production", {"q": inp["q"]})).messages[0]["content"]

    async with server.client() as hub:
        await hub.experiments.compare_local(
            "ds-1",
            task=agent,
            scorers=[hub.experiments.judge("gpt-4o-mini", judge_prompt_id="jp-1", judge_prompt_version=3)],
            variants={"production": None, "candidate-B": {"support-agent": 7}},
        )
    # Both variants grade with the one version the optimize run graded with.
    assert len(server.judge_calls) == 4
    assert {(c["judge_prompt_id"], c["judge_prompt_version"]) for c in server.judge_calls} == {("jp-1", 3)}


def test_judge_prompt_version_needs_a_judge_prompt() -> None:
    async def run() -> None:
        async with FakeServer().client() as hub:
            hub.experiments.judge("gpt-4o-mini", judge_prompt_version=3)

    with pytest.raises(ValueError, match="judge_prompt_version needs judge_prompt_id"):
        asyncio.run(run())


def test_pinned_version_reads_the_pin_an_app_puts_in_a_gateway_prompt_reference() -> None:
    assert pinned_version("support-agent") is None
    with pin_prompts({"support-agent": 7}):
        assert pinned_version("support-agent") == 7
        assert pinned_version("other") is None
