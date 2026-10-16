"""Unit tests for ``experiments.run_local`` (issue #596).

The real client runs end to end; only the HTTP boundary is replaced, by a small
in-memory stand-in for the four endpoints a local run uses (``POST
/experiments/local``, ``/traces``, ``/runs/:id/results``, ``/runs/:id/finish``). It
keeps the state the real server would — results replaced per example, the run's
status — so each test asserts on what the server would have stored, not only on
the returned object. The live check against a real server is in
``test_eval_live.py``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
import warnings
from typing import Any, Dict, List, Optional

import httpx
import pytest

import acruxcore.local_experiments as local_mod
from acruxcore import AcruxCore, AcruxCoreError, LocalExample, LocalRunResult, Score


def _reject_constant(name: str) -> Any:
    raise ValueError(f"{name} is not valid JSON")


class FakeServer:
    """Stateful stand-in for the local-experiment endpoints of ``apps/api``."""

    def __init__(self, examples: int = 3, *, fail_traces: bool = False) -> None:
        self.run_id = str(uuid.uuid4())
        self.examples = [
            {
                "id": str(uuid.uuid4()),
                "input": {"n": i},
                "criteria": f"criteria {i}",
                "expected": {"double": i * 2},
                "history": [{"role": "user", "content": "earlier turn"}] if i == 0 else None,
            }
            for i in range(examples)
        ]
        self.fail_traces = fail_traces
        self.fail_results_times = 0
        self.created: Optional[Dict[str, Any]] = None
        self.result_calls: List[List[Dict[str, Any]]] = []
        self.stored: Dict[str, Dict[str, Any]] = {}
        self.traces: List[Dict[str, Any]] = []
        self.finish_bodies: List[Dict[str, Any]] = []
        self.status = "running"

    def handler(self, request: httpx.Request) -> httpx.Response:
        try:
            # Strict, like express.json: NaN and Infinity are not JSON.
            body = json.loads(request.content, parse_constant=_reject_constant) if request.content else {}
        except ValueError:
            return httpx.Response(400, json={"error": {"message": "Request body is not valid JSON."}})
        path = request.url.path.replace("/api/v1", "", 1)
        if path == "/experiments/local":
            self.created = body
            return httpx.Response(
                201,
                json={
                    "experiment_id": "exp-1",
                    "run_id": self.run_id,
                    "cell_key": f"{body['name']}|local",
                    "url": f"http://app/evaluations/runs/{self.run_id}",
                    "examples": self.examples,
                },
            )
        if path == "/traces":
            if self.fail_traces:
                return httpx.Response(400, json={"error": {"message": "bad trace"}})
            self.traces.extend(body["traces"])
            return httpx.Response(201, json={"traceIds": [t["traceId"] for t in body["traces"]]})
        if path == f"/runs/{self.run_id}/results":
            if self.fail_results_times > 0:
                self.fail_results_times -= 1
                return httpx.Response(503, json={"error": {"message": "down"}})
            assert 1 <= len(body["results"]) <= 100
            self.result_calls.append(body["results"])
            for r in body["results"]:
                self.stored[r["example_id"]] = r  # replace, like the server
            return httpx.Response(
                200,
                json={"written": len(body["results"]), "completed": len(self.stored),
                      "total": len(self.examples)},
            )
        if path == f"/runs/{self.run_id}/finish":
            self.finish_bodies.append(body)
            self.status = "failed" if body.get("error") else "succeeded"
            return httpx.Response(200, json={"id": self.run_id, "kind": "local",
                                             "status": self.status, "error": body.get("error")})
        return httpx.Response(404, json={"error": {"message": f"no route {path}"}})

    def client(self) -> AcruxCore:
        return AcruxCore(
            api_key="test-key",
            base_url="http://localhost:3000/api/v1",
            transport=httpx.MockTransport(self.handler),
            max_retries=0,
            retry_interval=1,
        )


@pytest.fixture(autouse=True)
def _fast_upload_retries(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(local_mod, "_UPLOAD_RETRY_DELAYS", (0.0, 0.0))


def _scores_of(server: FakeServer, example_index: int) -> List[Dict[str, Any]]:
    return server.stored[server.examples[example_index]["id"]]["scores"]


# --- tasks ------------------------------------------------------------------


async def test_sync_one_arg_task_with_bool_scorer_uploads_scaled_scores() -> None:
    server = FakeServer(examples=3)
    seen_threads = []

    def task(inp: Dict[str, Any]) -> Dict[str, Any]:
        import threading
        seen_threads.append(threading.current_thread().name)
        return {"double": inp["n"] * 2}

    def exact(output: Any, expected: Any) -> bool:
        return output == expected

    async with server.client() as hub:
        result = await hub.experiments.run_local(
            "ds-1", task=task, scorers=[exact], name="v1"
        )

    assert isinstance(result, LocalRunResult)
    assert result.run_id == server.run_id and result.status == "succeeded"
    assert server.created == {"dataset_id": "ds-1", "name": "v1"}  # no guessed primary score
    # sync tasks run off the event loop's thread
    assert all(name != "MainThread" for name in seen_threads)
    for i in range(3):
        assert _scores_of(server, i) == [{"name": "exact", "score": 100.0, "passed": True, "reason": None}]
        assert server.stored[server.examples[i]["id"]]["output"] == {"double": i * 2}
    assert [item.scores[0].score for item in result.items] == [1.0, 1.0, 1.0]
    assert result.summary["exact"].mean == 1.0 and result.summary["exact"].pass_rate == 1.0
    assert server.finish_bodies == [{}]


async def test_async_two_arg_task_gets_context_with_trace_option() -> None:
    server = FakeServer(examples=2)
    contexts: List[LocalExample] = []

    async def task(inp: Dict[str, Any], ctx: LocalExample) -> str:
        contexts.append(ctx)
        await asyncio.sleep(0)
        return f"n={inp['n']}"

    async with server.client() as hub:
        result = await hub.experiments.run_local("ds", task=task, name="v2", model="glm")

    assert server.created and server.created["model"] == "glm"
    assert "primary_score" not in server.created  # no scorers, no default
    by_id = {c.id: c for c in contexts}
    for ex in server.examples:
        ctx = by_id[ex["id"]]
        assert ctx.example_id == ex["id"]
        assert ctx.expected == ex["expected"] and ctx.criteria == ex["criteria"]
        assert ctx.trace == {"trace_id": ctx.trace_id}
        uuid.UUID(ctx.trace_id)
        assert server.stored[ex["id"]]["trace_id"] == ctx.trace_id
    assert [i.output for i in result.items] == ["n=0", "n=1"]  # dataset order


async def test_task_error_becomes_errored_result_and_skips_scorers() -> None:
    server = FakeServer(examples=2)
    scored: List[Any] = []

    def task(inp: Dict[str, Any]) -> int:
        if inp["n"] == 1:
            raise RuntimeError("boom")
        return 7

    def check(output: Any) -> float:
        scored.append(output)
        return 0.25

    async with server.client() as hub:
        result = await hub.experiments.run_local("ds", task=task, scorers=[check], name="v")

    bad = server.stored[server.examples[1]["id"]]
    assert bad["error"] == "RuntimeError: boom" and bad["scores"] == []
    assert scored == [7]
    assert _scores_of(server, 0) == [{"name": "check", "score": 25.0, "passed": False, "reason": None}]
    assert result.items[1].error == "RuntimeError: boom"
    # the trace span for the failed example records the error
    failed_span = next(t for t in server.traces if t["traceId"] == bad["trace_id"])["spans"][0]
    assert failed_span["status"] == "error" and failed_span["error"] == "RuntimeError: boom"
    assert server.finish_bodies == [{}]


# --- scorers ----------------------------------------------------------------


async def test_scorers_receive_only_declared_kwargs() -> None:
    server = FakeServer(examples=1)
    calls: Dict[str, Dict[str, Any]] = {}

    def only_output(output):  # type: ignore[no-untyped-def]
        calls["only_output"] = {"output": output}
        return True

    async def with_input_and_criteria(input, criteria):  # type: ignore[no-untyped-def]
        calls["with_input_and_criteria"] = {"input": input, "criteria": criteria}
        return 1

    def everything(**kwargs):  # type: ignore[no-untyped-def]
        calls["everything"] = kwargs
        return 0.5

    async with server.client() as hub:
        await hub.experiments.run_local(
            "ds", task=lambda inp: "out",
            scorers=[only_output, with_input_and_criteria, everything], name="v",
        )

    ex = server.examples[0]
    assert calls["only_output"] == {"output": "out"}
    assert calls["with_input_and_criteria"] == {"input": ex["input"], "criteria": ex["criteria"]}
    assert set(calls["everything"]) == {"output", "expected", "input", "criteria", "example"}
    assert isinstance(calls["everything"]["example"], LocalExample)
    assert [s["name"] for s in _scores_of(server, 0)] == [
        "only_output", "with_input_and_criteria", "everything"]


async def test_every_scorer_return_type_is_normalized() -> None:
    server = FakeServer(examples=1)

    def as_false(output):  # type: ignore[no-untyped-def]
        return False

    def as_float(output):  # type: ignore[no-untyped-def]
        return 0.7

    def as_dict(output):  # type: ignore[no-untyped-def]
        return {"score": 0.4, "reason": "close"}

    def as_named_dict(output):  # type: ignore[no-untyped-def]
        return {"name": "custom", "score": None, "reason": "no reference"}

    def as_score(output):  # type: ignore[no-untyped-def]
        return Score(score=0.9, passed=False, reason="strict")

    def as_list(output):  # type: ignore[no-untyped-def]
        return [Score(name="a", score=1), {"name": "b", "score": 0.0}, True]

    async with server.client() as hub:
        result = await hub.experiments.run_local(
            "ds", task=lambda inp: "x",
            scorers=[as_false, as_float, as_dict, as_named_dict, as_score, as_list],
            name="v", primary_score="as_float",
        )

    assert server.created and server.created["primary_score"] == "as_float"
    assert _scores_of(server, 0) == [
        {"name": "as_false", "score": 0.0, "passed": False, "reason": None},
        {"name": "as_float", "score": 70.0, "passed": True, "reason": None},
        {"name": "as_dict", "score": 40.0, "passed": False, "reason": "close"},
        {"name": "custom", "score": None, "passed": None, "reason": "no reference"},
        {"name": "as_score", "score": 90.0, "passed": False, "reason": "strict"},
        {"name": "a", "score": 100.0, "passed": True, "reason": None},
        {"name": "b", "score": 0.0, "passed": False, "reason": None},
        {"name": "as_list_3", "score": 100.0, "passed": True, "reason": None},
    ]
    # local items stay on the 0–1 scale; a None score is left out of the summary
    assert result.items[0].scores[1].score == 0.7
    assert result.summary["custom"].mean is None and result.summary["custom"].count == 0
    assert result.summary["as_float"].mean == 0.7


async def test_scorer_error_and_out_of_range_become_null_scores() -> None:
    server = FakeServer(examples=2)

    def raises(output):  # type: ignore[no-untyped-def]
        raise KeyError("missing")

    def too_big(output):  # type: ignore[no-untyped-def]
        return 85  # a 0–100 score by mistake

    def fine(output):  # type: ignore[no-untyped-def]
        return True

    async with server.client() as hub:
        result = await hub.experiments.run_local(
            "ds", task=lambda inp: 1, scorers=[raises, too_big, fine], name="v")

    scores = _scores_of(server, 0)
    assert scores[0] == {"name": "raises", "score": None, "passed": None, "reason": "KeyError: 'missing'"}
    assert scores[1]["name"] == "too_big" and scores[1]["score"] is None
    assert "between 0 and 1" in scores[1]["reason"]
    assert scores[2]["score"] == 100.0  # the run went on
    assert result.status == "succeeded"


# --- batching, traces, finish -----------------------------------------------


async def test_45_examples_upload_in_three_batches() -> None:
    server = FakeServer(examples=45)
    async with server.client() as hub:
        result = await hub.experiments.run_local(
            "ds", task=lambda inp: inp["n"], name="v", concurrency=8)

    assert sorted(len(call) for call in server.result_calls) == [5, 20, 20]
    assert len(server.stored) == 45 and len(result.items) == 45
    assert [item.output for item in result.items] == list(range(45))


async def test_failed_batch_upload_is_retried() -> None:
    server = FakeServer(examples=3)
    server.fail_results_times = 2  # two 503s, then success on the third attempt
    async with server.client() as hub:
        result = await hub.experiments.run_local("ds", task=lambda inp: 1, name="v")
    assert len(server.stored) == 3 and result.status == "succeeded"


async def test_trace_ingest_failure_warns_and_sends_no_trace_id() -> None:
    server = FakeServer(examples=2, fail_traces=True)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        async with server.client() as hub:
            result = await hub.experiments.run_local("ds", task=lambda inp: 1, name="v")

    assert all(r["trace_id"] is None for r in server.stored.values())
    assert all(item.trace_id is None for item in result.items)
    assert any("could not file the trace" in str(w.message) for w in caught)


async def test_trace_span_is_a_chain_span_with_run_attributes() -> None:
    server = FakeServer(examples=1)
    async with server.client() as hub:
        await hub.experiments.run_local("ds", task=lambda inp: {"ok": True}, name="my-run")

    (trace,) = server.traces
    (span,) = trace["spans"]
    ex = server.examples[0]
    assert trace["traceId"] == server.stored[ex["id"]]["trace_id"]
    assert span["kind"] == "chain" and span["name"] == "my-run" and span["status"] == "ok"
    assert span["input"] == ex["input"] and span["output"] == {"ok": True}
    assert span["attributes"] == {"experiment_run_id": server.run_id, "example_id": ex["id"]}
    assert span["endTime"] >= span["startTime"]


async def test_non_json_output_is_uploaded_as_repr() -> None:
    server = FakeServer(examples=1)

    class Thing:
        def __repr__(self) -> str:
            return "Thing()"

    thing = Thing()
    async with server.client() as hub:
        result = await hub.experiments.run_local("ds", task=lambda inp: thing, name="v")

    assert server.stored[server.examples[0]["id"]]["output"] == "Thing()"
    assert result.items[0].output is thing  # the caller still gets the real object


class Abort(BaseException):
    """A non-``Exception`` error, like the ones a task cannot be expected to handle.

    ``KeyboardInterrupt`` itself is not raised here: asyncio re-raises it straight out
    of the event loop, past every coroutine. Under ``asyncio.run`` a real Ctrl-C
    arrives as a cancellation instead, which ``test_cancellation_...`` covers.
    """


async def test_loop_failure_finishes_run_with_error_then_reraises() -> None:
    server = FakeServer(examples=3)

    def task(inp: Dict[str, Any]) -> int:
        if inp["n"] == 1:
            raise Abort("stop")  # a BaseException is a loop failure, not a result
        return inp["n"]

    with pytest.raises(Abort):
        async with server.client() as hub:
            await hub.experiments.run_local("ds", task=task, name="v", concurrency=1)

    assert server.finish_bodies == [{"error": "Abort: stop"}]
    assert server.status == "failed"
    # the example finished before the interrupt was still uploaded
    assert server.examples[0]["id"] in server.stored


async def test_upload_that_keeps_failing_fails_the_run() -> None:
    server = FakeServer(examples=2)
    server.fail_results_times = 99
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with pytest.raises(AcruxCoreError) as info:
            async with server.client() as hub:
                await hub.experiments.run_local("ds", task=lambda inp: 1, name="v")
    assert info.value.status_code == 503
    assert len(server.finish_bodies) == 1
    assert "503" in server.finish_bodies[0]["error"]


async def test_cancellation_finishes_run_with_error() -> None:
    server = FakeServer(examples=4)
    started = asyncio.Event()

    async def task(inp: Dict[str, Any]) -> int:
        started.set()
        await asyncio.sleep(30)
        return 1

    async with server.client() as hub:
        job = asyncio.ensure_future(hub.experiments.run_local("ds", task=task, name="v"))
        await started.wait()
        job.cancel()
        with pytest.raises(asyncio.CancelledError):
            await job

    assert server.finish_bodies == [{"error": "CancelledError"}]


async def test_format_prints_summary_table() -> None:
    server = FakeServer(examples=2)

    def exact(output, expected):  # type: ignore[no-untyped-def]
        return output == expected

    async with server.client() as hub:
        result = await hub.experiments.run_local(
            "ds", task=lambda inp: {"double": 0}, scorers=[exact], name="v")

    text = str(result)
    assert server.run_id in text and "succeeded" in text
    assert "exact" in text and "50%" in text


async def test_add_example_sends_expected_and_reads_it_back() -> None:
    sent: List[Dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append(body)
        return httpx.Response(201, json={"id": "e1", "datasetId": "d", "input": body["input"],
                                         "expected": body.get("expected")})

    async with AcruxCore(api_key="k", base_url="http://localhost:3000/api/v1",
                         transport=httpx.MockTransport(handler)) as hub:
        example = await hub.datasets.add_example("d", {"q": "hi"}, expected={"items": [1, 2]})
        plain = await hub.datasets.add_example("d", {"q": "no ref"})

    assert sent[0]["expected"] == {"items": [1, 2]} and "expected" not in sent[1]
    assert example.expected == {"items": [1, 2]} and plain.expected is None


# --- PR #602 review fixes -----------------------------------------------------


async def test_default_primary_score_is_not_guessed_from_the_function_name() -> None:
    """A scorer that names its own score must not leave the run unscored."""
    server = FakeServer(examples=2)

    def quality(output: Any) -> Score:
        return Score(name="accuracy", score=1.0)

    async with server.client() as hub:
        await hub.experiments.run_local("ds-1", task=lambda x: x, scorers=[quality], name="v1")

    # No guess: the server then uses each result's first score, as with the Node SDK.
    assert "primary_score" not in (server.created or {})


async def test_nan_and_infinity_in_an_output_are_sent_as_valid_json() -> None:
    server = FakeServer(examples=2)
    async with server.client() as hub:
        result = await hub.experiments.run_local(
            "ds-1", task=lambda x: {"avg": float("nan"), "max": float("inf"), "ok": 1.5},
            scorers=[lambda output: True], name="v1",
        )
    assert result.status == "succeeded"
    stored = server.stored[server.examples[0]["id"]]["output"]
    assert stored == {"avg": None, "max": None, "ok": 1.5}  # like JSON.stringify in Node
    assert server.traces, "the chain span must be accepted too"


async def test_long_non_ascii_output_is_cut_to_the_servers_byte_cap() -> None:
    server = FakeServer(examples=1)
    async with server.client() as hub:
        await hub.experiments.run_local("ds-1", task=lambda x: "中" * 40_000, name="v1")
    out = server.stored[server.examples[0]["id"]]["output"]
    # The server measures UTF-8 bytes of JSON.stringify (no \u escapes).
    assert len(json.dumps(out, ensure_ascii=False).encode("utf-8")) <= 64 * 1024
    assert "truncated" in out


async def test_non_ascii_output_under_the_cap_is_not_truncated() -> None:
    server = FakeServer(examples=1)
    answer = {"answer": "中" * 12_000}  # about 36 KB as UTF-8, about 72 KB with \u escapes
    async with server.client() as hub:
        await hub.experiments.run_local("ds-1", task=lambda x: answer, name="v1")
    assert server.stored[server.examples[0]["id"]]["output"] == answer


async def test_results_are_uploaded_on_a_timer_before_a_batch_fills(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(local_mod, "_FLUSH_INTERVAL_S", 0.02)
    server = FakeServer(examples=3)

    async def slow(inp: Dict[str, Any]) -> int:
        await asyncio.sleep(0.04)
        return inp["n"]

    async with server.client() as hub:
        await hub.experiments.run_local("ds-1", task=slow, name="v1", concurrency=1)
    assert [len(call) for call in server.result_calls] == [1, 1, 1]


async def test_task_context_carries_the_example_history() -> None:
    server = FakeServer(examples=2)
    seen: Dict[int, Any] = {}

    def task(inp: Dict[str, Any], ctx: LocalExample) -> int:
        seen[inp["n"]] = ctx.history
        return 0

    async with server.client() as hub:
        await hub.experiments.run_local("ds-1", task=task, name="v1")
    assert seen == {0: [{"role": "user", "content": "earlier turn"}], 1: None}


async def test_renamed_scores_never_collide_with_a_real_name() -> None:
    server = FakeServer(examples=1)

    def exact(output: Any) -> bool:
        return True

    def exact_b(output: Any) -> bool:
        return True
    exact_b.__name__ = "exact"

    def exact_list(output: Any) -> List[float]:
        return [1.0, 0.0]
    exact_list.__name__ = "exact"

    async with server.client() as hub:
        result = await hub.experiments.run_local(
            "ds-1", task=lambda x: x, scorers=[exact, exact_b, exact_list], name="v1"
        )
    names = [s["name"] for s in _scores_of(server, 0)]
    assert len(set(names)) == len(names) == 4, names
    assert result.status == "succeeded"

