"""Local experiments: run your own app code over a dataset and upload it as a run.

A server-side experiment runs one stored prompt per example and grades it with an
LLM judge. A real app is usually several prompts, tool calls and plain code, and is
often checked by code rather than by a judge. A local experiment splits the work
the other way round: the SDK calls your ``task`` and your ``scorers`` on your
machine, and the server stores the outcome as an ordinary run, so it shows up under
Evaluation → Runs, in the report and in Compare per example like any other run.

The flow is four calls: ``POST /experiments/local`` freezes the dataset's examples
and opens a ``running`` run, ``POST /runs/:id/results`` uploads results in batches,
one ``POST /traces`` per example files a ``chain`` span so every result opens a
trace, and ``POST /runs/:id/finish`` closes the run.

Scores are 0–1 in Python, like Langfuse and LangSmith. The wire format is 0–100,
like the judge's, so the SDK multiplies by 100 on upload.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import time
import uuid
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import (
    TYPE_CHECKING,
    Any,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Optional,
    Sequence,
    Union,
)
from urllib.parse import quote

from .errors import NETWORK_ERROR, AcruxCoreError

if TYPE_CHECKING:
    from .client import AcruxCore

#: Results per ``POST /runs/:id/results`` call. The server accepts up to 100; 20 keeps
#: a crash from losing much work and keeps each request small.
RESULT_BATCH_SIZE = 20

#: Byte budget for one results request. The API's body limit is 1 MB and one output
#: may be up to 64 KB, so 20 large outputs would not fit in one request.
_BATCH_BYTE_BUDGET = 800_000

#: The server rejects an ``output`` that serializes to more than this many bytes.
_MAX_OUTPUT_BYTES = 64 * 1024

#: The server caps ``error`` and ``reason`` strings at this length.
_MAX_TEXT = 5000

#: The server caps a score name at this length.
_MAX_SCORE_NAME = 100

#: Finished results are uploaded at least this often (seconds), even when fewer than a
#: batch are waiting. The stale-run sweep fails a running run that has stored no new
#: result for 120 minutes, so a run of slow examples must upload as it goes.
_FLUSH_INTERVAL_S = 60.0

#: Waits, in seconds, before each retry of a failed results upload. Retrying is safe
#: because the server replaces an example's result instead of adding a second one.
_UPLOAD_RETRY_DELAYS: Sequence[float] = (0.5, 1.5)

#: Keyword arguments a scorer may declare. Only the ones it declares are passed.
_SCORER_KWARGS = ("output", "expected", "input", "criteria", "example")


# ── public types ──────────────────────────────────────────────────────────────


@dataclass
class Score:
    """One named score a scorer returns.

    ``score`` is 0–1, or ``None`` when the scorer could not decide (a missing
    reference, an unparsable output). A ``None`` score is stored and shown, but it
    is left out of the mean and the pass rate.

    ``passed`` defaults to ``score >= 0.5`` when it is left out and the score is
    not ``None``. ``name`` defaults to the scorer function's ``__name__``; set it
    when one scorer returns several scores.
    """

    score: Optional[float]
    name: Optional[str] = None
    passed: Optional[bool] = None
    reason: Optional[str] = None


@dataclass
class LocalExample:
    """The context your ``task`` gets as its second argument (and scorers as ``example``).

    ``trace`` is ready to pass to gateway calls as ``trace=ctx.trace``. The calls
    then land in this example's trace, next to the ``chain`` span the SDK files for
    the task itself, so the run's drill-down opens one trace per example that holds
    everything the app did.

    ``history`` holds the earlier turns of an example built from a multi-turn
    session, or ``None``. A server-side run replays them before the input; pass them
    to your app to do the same.
    """

    id: str
    input: Dict[str, Any]
    expected: Any
    criteria: Optional[str]
    trace_id: str
    trace: Dict[str, Any] = field(default_factory=dict)
    history: Optional[List[Dict[str, Any]]] = None

    @property
    def example_id(self) -> str:
        """The dataset example's id. Same as :attr:`id`; named to match the other SDK."""
        return self.id


@dataclass
class LocalRunItem:
    """What happened to one example.

    ``output`` is what the task returned, as the Python object (not the JSON that was
    uploaded). ``error`` is ``"<ExceptionType>: <message>"`` when the task raised;
    the example then has no scores. ``trace_id`` is ``None`` when the SDK could not
    file the example's trace, so it never points at a trace that does not exist.
    """

    example_id: str
    input: Dict[str, Any]
    expected: Any
    output: Any
    error: Optional[str]
    trace_id: Optional[str]
    scores: List[Score] = field(default_factory=list)


@dataclass
class ScoreSummary:
    """Mean and pass rate of one named score over the examples that have it.

    Both are 0–1. ``count`` is the number of non-``None`` scores behind them, so a
    scorer that errored on half the examples shows ``count`` at half the total.
    ``mean`` and ``pass_rate`` are ``None`` when no example has the score.
    """

    name: str
    mean: Optional[float]
    pass_rate: Optional[float]
    count: int


@dataclass
class LocalRunResult:
    """The outcome of :meth:`ExperimentsNamespace.run_local`.

    ``url`` opens the run in the dashboard; it is ``None`` when the server has no
    ``APP_URL`` configured. ``status`` is the run's final status from the server:
    ``succeeded``, or ``failed`` when every example errored.

    ``print(result)`` shows a short table of the summary; :meth:`format` returns it.
    """

    run_id: str
    experiment_id: str
    url: Optional[str]
    status: str
    items: List[LocalRunItem] = field(default_factory=list)
    summary: Dict[str, ScoreSummary] = field(default_factory=dict)

    def format(self) -> str:
        """Render the run as a short plain-text table: one row per score name.

        :returns: A multi-line string. Errored examples are counted on the header line.
        """
        errored = sum(1 for item in self.items if item.error is not None)
        lines = [
            f"Local run {self.run_id} — {self.status}, "
            f"{len(self.items)} examples, {errored} errored"
        ]
        if self.url:
            lines.append(self.url)
        if self.summary:
            width = max(len("score"), *(len(name) for name in self.summary))
            lines.append("")
            lines.append(f"{'score'.ljust(width)}  {'mean':>6}  {'pass':>6}  {'n':>5}")
            for name, row in self.summary.items():
                lines.append(
                    f"{name.ljust(width)}  {_pct(row.mean):>6}  "
                    f"{_pct(row.pass_rate):>6}  {row.count:>5}"
                )
        return "\n".join(lines)

    def __str__(self) -> str:
        return self.format()


#: What a scorer may return: a bool, a 0–1 number, a :class:`Score`, a dict with the
#: same keys, or a list of those.
ScorerReturn = Union[bool, int, float, Score, Dict[str, Any], List[Any], None]


# ── runner ────────────────────────────────────────────────────────────────────


async def run_local_experiment(
    client: "AcruxCore",
    dataset_id: str,
    *,
    task: Callable[..., Any],
    scorers: Iterable[Callable[..., Any]] = (),
    name: str,
    model: Optional[str] = None,
    primary_score: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    concurrency: int = 4,
) -> LocalRunResult:
    """Run ``task`` over every example of a dataset, score it, and upload it as a run.

    See :meth:`acruxcore.evaluations.ExperimentsNamespace.run_local` for the
    contract. This function holds the implementation so the namespace stays a thin
    wrapper.

    :raises ValueError: ``concurrency`` is below 1.
    :raises AcruxCoreError: Creating the run failed, a results batch still failed
        after its retries, or ``finish`` failed on an otherwise clean run.
    """
    if concurrency < 1:
        raise ValueError("acruxcore: run_local concurrency must be at least 1.")
    scorer_list = list(scorers)
    # No default from the first scorer's __name__: a scorer may name its own scores
    # (``Score(name=...)``, a list), and a guessed name that matches none of them
    # would store every result as unscored. Omitted, the server uses each result's
    # first score — the same rule the Node SDK relies on.

    body: Dict[str, Any] = {"dataset_id": dataset_id, "name": name}
    if model is not None:
        body["model"] = model
    if primary_score is not None:
        body["primary_score"] = primary_score
    if metadata is not None:
        body["metadata"] = metadata
    created = client._parse_json_or_throw(
        await client._request("POST", "/experiments/local", body, "creating local experiment"),
        "creating local experiment",
    )
    run_id: str = created["run_id"]
    runner = _Runner(client, run_id, name, task, scorer_list, concurrency)

    loop_error: Optional[BaseException] = None
    detail: Dict[str, Any] = {}
    try:
        await runner.run_all(created.get("examples") or [])
        await runner.flush(final=True)
    except BaseException as exc:  # noqa: BLE001 — re-raised below after finish
        loop_error = exc
        raise
    finally:
        if loop_error is not None:
            # Best effort: keep the results that are already done, then close the run as
            # failed. Neither step may hide the original error, so both only warn.
            try:
                await runner.flush(final=True, retry=False)
            except BaseException as flush_err:  # noqa: BLE001
                warnings.warn(
                    f"acruxcore: could not upload the last results of run {run_id}: "
                    f"{_describe(flush_err)}",
                    stacklevel=2,
                )
            try:
                await _finish(client, run_id, _describe(loop_error))
            except BaseException as finish_err:  # noqa: BLE001
                warnings.warn(
                    f"acruxcore: could not mark run {run_id} as failed: "
                    f"{_describe(finish_err)}. The server fails it after it stops "
                    "making progress.",
                    stacklevel=2,
                )
        else:
            detail = await _finish(client, run_id, None)

    items = runner.items_in_order()
    return LocalRunResult(
        run_id=run_id,
        experiment_id=created.get("experiment_id") or "",
        url=created.get("url"),
        status=detail.get("status") or "",
        items=items,
        summary=_summarize(items),
    )


class _Runner:
    """Per-run state: the examples' items, the pending upload buffer, and its lock."""

    def __init__(
        self,
        client: "AcruxCore",
        run_id: str,
        run_name: str,
        task: Callable[..., Any],
        scorers: List[Callable[..., Any]],
        concurrency: int,
    ) -> None:
        self._client = client
        self._run_id = run_id
        self._run_name = run_name
        self._task = task
        self._task_takes_context = _accepts_two_positional(task)
        self._scorers = scorers
        self._semaphore = asyncio.Semaphore(concurrency)
        self._upload_lock = asyncio.Lock()
        self._pending: List[Dict[str, Any]] = []
        self._last_flush = time.monotonic()
        self._order: List[str] = []
        self._items: Dict[str, LocalRunItem] = {}

    async def run_all(self, examples: List[Dict[str, Any]]) -> None:
        """Run every example, cancelling the rest as soon as one fails the loop itself.

        A task or scorer exception never reaches here: each becomes part of a result.
        What does reach here is a failure of the run as a whole — an upload that kept
        failing, or a ``BaseException`` such as ``KeyboardInterrupt`` from the task.
        """
        self._order = [str(ex.get("id")) for ex in examples]
        tasks = [asyncio.ensure_future(self._run_one(ex)) for ex in examples]
        try:
            await asyncio.gather(*tasks)
        except BaseException:
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise

    async def _run_one(self, example: Dict[str, Any]) -> None:
        async with self._semaphore:
            item, wire = await self._execute(example)
        self._items[item.example_id] = item
        self._pending.append(wire)
        if len(self._pending) >= RESULT_BATCH_SIZE:
            await self.flush(final=False)
        elif time.monotonic() - self._last_flush >= _FLUSH_INTERVAL_S:
            await self.flush(final=True)  # everything waiting, not only full batches

    async def _execute(self, example: Dict[str, Any]) -> "tuple[LocalRunItem, Dict[str, Any]]":
        trace_id = str(uuid.uuid4())
        ctx = LocalExample(
            id=str(example.get("id")),
            input=example.get("input") or {},
            expected=example.get("expected"),
            criteria=example.get("criteria"),
            trace_id=trace_id,
            trace={"trace_id": trace_id},
            history=example.get("history"),
        )

        started = datetime.now(timezone.utc)
        output: Any = None
        error: Optional[str] = None
        try:
            args = (ctx.input, ctx) if self._task_takes_context else (ctx.input,)
            output = await _call_maybe_async(self._task, *args)
        except Exception as exc:  # a task error is a result, not a run failure
            error = _clip(_describe(exc))
        ended = datetime.now(timezone.utc)

        scores: List[Score] = []
        if error is None:
            for scorer in self._scorers:
                scores.extend(await _run_scorer(scorer, output, ctx))
            scores = _dedupe_names(scores)

        filed = await self._file_trace(ctx, output, error, started, ended)
        item = LocalRunItem(
            example_id=ctx.id,
            input=ctx.input,
            expected=ctx.expected,
            output=output,
            error=error,
            trace_id=trace_id if filed else None,
            scores=scores,
        )
        wire: Dict[str, Any] = {
            "example_id": ctx.id,
            "output": _jsonable_output(output),
            "trace_id": trace_id if filed else None,
            "scores": [_score_to_wire(s) for s in scores],
        }
        if error is not None:
            wire["error"] = error
        return item, wire

    async def _file_trace(
        self,
        ctx: LocalExample,
        output: Any,
        error: Optional[str],
        started: datetime,
        ended: datetime,
    ) -> bool:
        """Ingest one ``chain`` span for the task into the example's trace.

        Returns whether it landed. On failure it warns and returns ``False``, so the
        result is uploaded without a ``trace_id`` rather than linking a missing trace.
        """
        span: Dict[str, Any] = {
            "spanId": uuid.uuid4().hex,
            "name": self._run_name,
            "kind": "chain",
            "status": "error" if error is not None else "ok",
            "startTime": started.isoformat(),
            "endTime": ended.isoformat(),
            "input": _jsonable(ctx.input),
            "attributes": {"experiment_run_id": self._run_id, "example_id": ctx.id},
        }
        if error is not None:
            span["error"] = error
        else:
            span["output"] = _jsonable_output(output)
        try:
            await self._client.traces.ingest(
                {"traceId": ctx.trace_id, "name": self._run_name, "spans": [span]}
            )
            return True
        except Exception as exc:  # noqa: BLE001 — a missing trace must not stop the run
            warnings.warn(
                f"acruxcore: could not file the trace for example {ctx.id}: "
                f"{_describe(exc)}. Its result is uploaded without a trace link.",
                stacklevel=2,
            )
            return False

    async def flush(self, *, final: bool, retry: bool = True) -> None:
        """Upload pending results: full batches while running, everything at the end."""
        async with self._upload_lock:
            self._last_flush = time.monotonic()
            while self._pending and (final or len(self._pending) >= RESULT_BATCH_SIZE):
                batch = _take_batch(self._pending)
                await self._upload(batch, retry=retry)
                del self._pending[: len(batch)]

    async def _upload(self, batch: List[Dict[str, Any]], *, retry: bool) -> None:
        delays = list(_UPLOAD_RETRY_DELAYS) if retry else []
        path = f"/runs/{quote(self._run_id, safe='')}/results"
        while True:
            try:
                response = await self._client._request(
                    "POST", path, {"results": batch}, "uploading local results"
                )
                self._client._parse_json_or_throw(response, "uploading local results")
                return
            except AcruxCoreError as err:
                # A 4xx is a bad payload or a closed run: retrying cannot fix it.
                transient = err.code == NETWORK_ERROR or (
                    err.status_code is not None and _is_transient(err.status_code)
                )
                if not transient or not delays:
                    raise
            await asyncio.sleep(delays.pop(0))

    def items_in_order(self) -> List[LocalRunItem]:
        """Items in dataset order, skipping examples that never finished."""
        return [self._items[i] for i in self._order if i in self._items]


async def _finish(client: "AcruxCore", run_id: str, error: Optional[str]) -> Dict[str, Any]:
    body: Dict[str, Any] = {"error": _clip(error)} if error else {}
    response = await client._request(
        "POST", f"/runs/{quote(run_id, safe='')}/finish", body, "finishing local run"
    )
    return client._parse_json_or_throw(response, "finishing local run")


# ── calling user code ─────────────────────────────────────────────────────────


def _accepts_two_positional(fn: Callable[..., Any]) -> bool:
    """True when ``fn`` can take ``(input, ctx)``; False when it takes only ``input``."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):  # a builtin or C callable with no signature
        return False
    positional = 0
    for p in params:
        if p.kind is inspect.Parameter.VAR_POSITIONAL:
            return True
        if p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD):
            positional += 1
    return positional >= 2


def _is_async_callable(fn: Callable[..., Any]) -> bool:
    if inspect.iscoroutinefunction(fn):
        return True
    call = getattr(fn, "__call__", None)
    return call is not None and inspect.iscoroutinefunction(call)


async def _call_maybe_async(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """Await an async callable; run a sync one in a thread so it cannot block the loop.

    A sync function that returns an awaitable (a wrapper around an async one) is
    awaited too.
    """
    if _is_async_callable(fn):
        return await fn(*args, **kwargs)
    result = await asyncio.to_thread(fn, *args, **kwargs)
    if inspect.isawaitable(result):
        return await result
    return result


async def _run_scorer(scorer: Callable[..., Any], output: Any, ctx: LocalExample) -> List[Score]:
    """Call one scorer and normalize what it returns. An exception becomes a null score."""
    name = _callable_name(scorer)
    available = {
        "output": output,
        "expected": ctx.expected,
        "input": ctx.input,
        "criteria": ctx.criteria,
        "example": ctx,
    }
    try:
        kwargs = _scorer_kwargs(scorer, available)
        returned = await _call_maybe_async(scorer, **kwargs)
        return _normalize(returned, name)
    except Exception as exc:  # a scorer error is a null score, never a run failure
        return [Score(name=name, score=None, passed=None, reason=_clip(_describe(exc)))]


def _scorer_kwargs(scorer: Callable[..., Any], available: Dict[str, Any]) -> Dict[str, Any]:
    try:
        params = inspect.signature(scorer).parameters
    except (TypeError, ValueError):
        return dict(available)
    if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return dict(available)
    return {
        key: value
        for key, value in available.items()
        if key in params and params[key].kind is not inspect.Parameter.POSITIONAL_ONLY
    }


def _normalize(returned: ScorerReturn, default_name: str) -> List[Score]:
    """Turn any allowed scorer return value into a list of named, validated scores.

    :raises ValueError: A score outside 0–1, or a value of an unsupported type.
    """
    if isinstance(returned, (list, tuple)):
        scores: List[Score] = []
        for index, part in enumerate(returned):
            fallback = default_name if len(returned) == 1 else f"{default_name}_{index + 1}"
            scores.extend(_normalize(part, fallback))
        return scores
    if isinstance(returned, bool):
        return [Score(name=default_name, score=1.0 if returned else 0.0, passed=returned)]
    if isinstance(returned, (int, float)):
        value = _check_range(float(returned), default_name)
        return [Score(name=default_name, score=value, passed=value >= 0.5)]
    if isinstance(returned, Score):
        return [_complete(returned.name, returned.score, returned.passed, returned.reason, default_name)]
    if isinstance(returned, dict):
        if "score" not in returned:
            raise ValueError(
                f"scorer {default_name!r} returned a dict without a 'score' key; "
                "use {'score': 0.8} (0–1, or None)."
            )
        return [
            _complete(
                returned.get("name"),
                returned.get("score"),
                returned.get("passed"),
                returned.get("reason"),
                default_name,
            )
        ]
    raise ValueError(
        f"scorer {default_name!r} returned {type(returned).__name__}; return a bool, a "
        "number in 0–1, a Score, a dict with 'score', or a list of those."
    )


def _complete(
    name: Optional[str], score: Any, passed: Any, reason: Any, default_name: str
) -> Score:
    final_name = str(name) if name else default_name
    value: Optional[float] = None
    if score is not None:
        if isinstance(score, bool):
            value = 1.0 if score else 0.0
        elif isinstance(score, (int, float)):
            value = _check_range(float(score), final_name)
        else:
            raise ValueError(
                f"score {final_name!r} is {type(score).__name__}; it must be a number in 0–1 or None."
            )
    if passed is None and value is not None:
        passed = value >= 0.5
    return Score(
        name=final_name,
        score=value,
        passed=None if passed is None else bool(passed),
        reason=None if reason is None else _clip(str(reason)),
    )


def _check_range(value: float, name: str) -> float:
    if not (0.0 <= value <= 1.0):  # also rejects NaN
        raise ValueError(
            f"score {name!r} is {value}; scores must be between 0 and 1 "
            "(the SDK sends them as 0–100)."
        )
    return value


def _dedupe_names(scores: List[Score]) -> List[Score]:
    """Rename repeats to ``x_2``, ``x_3``, … — the server rejects duplicate names in one result.

    A suffix that is already a name in the result is skipped, so a rename never
    collides with a real score called ``x_2``. The Node SDK applies the same rule.
    """
    reserved = {(s.name or "score")[:_MAX_SCORE_NAME] for s in scores}
    used: set = set()
    out: List[Score] = []
    for s in scores:
        name = (s.name or "score")[:_MAX_SCORE_NAME]
        if name in used:
            n = 2
            while True:
                suffix = f"_{n}"
                candidate = f"{name[: _MAX_SCORE_NAME - len(suffix)]}{suffix}"
                n += 1
                if candidate not in used and candidate not in reserved:
                    break
            name = candidate
        used.add(name)
        out.append(Score(name=name, score=s.score, passed=s.passed, reason=s.reason))
    return out


def _callable_name(fn: Callable[..., Any]) -> str:
    name = getattr(fn, "__name__", None) or type(fn).__name__
    return name[:_MAX_SCORE_NAME]


# ── wire shaping ──────────────────────────────────────────────────────────────


def _score_to_wire(s: Score) -> Dict[str, Any]:
    return {
        "name": s.name,
        "score": None if s.score is None else round(s.score * 100, 4),
        "passed": s.passed,
        "reason": s.reason,
    }


def _finite(value: Any) -> Any:
    """``value`` with every NaN or infinite float replaced by ``None``.

    ``json.dumps`` writes them as the bare words ``NaN`` and ``Infinity``, which are
    not JSON, so the server rejects the whole request. ``None`` is what Node's
    ``JSON.stringify`` writes for them, so both SDKs store the same thing.
    """
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


def _jsonable(value: Any) -> Any:
    """``value`` as strict JSON (non-finite floats as ``None``), else its ``repr()``."""
    try:
        safe = _finite(value)
        json.dumps(safe, allow_nan=False)
        return safe
    except (TypeError, ValueError, RecursionError):
        return repr(value)


def _server_bytes(value: Any) -> int:
    """Size as the server measures it: UTF-8 bytes of ``JSON.stringify``, no ``\\u`` escapes."""
    return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))


def _jsonable_output(value: Any) -> Any:
    """A JSON-safe output that also fits the server's 64 KB cap (truncated text if not)."""
    safe = _jsonable(value)
    size = _server_bytes(safe)
    if size <= _MAX_OUTPUT_BYTES:
        return safe
    text = safe if isinstance(safe, str) else json.dumps(safe, ensure_ascii=False)
    marker = f"… [truncated by the SDK: output was {size} bytes, over 64 KB]"
    keep = _MAX_OUTPUT_BYTES // 2
    cut = f"{text[:keep]}{marker}"
    # Characters are not bytes: a CJK character is 3 bytes, an escaped quote 2.
    while _server_bytes(cut) > _MAX_OUTPUT_BYTES and keep > 0:
        keep //= 2
        cut = f"{text[:keep]}{marker}"
    return cut


def _take_batch(pending: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The first results that fit both the count cap and the request byte budget."""
    batch: List[Dict[str, Any]] = []
    size = 0
    for result in pending[:RESULT_BATCH_SIZE]:
        result_size = len(json.dumps(result).encode("utf-8"))
        if batch and size + result_size > _BATCH_BYTE_BUDGET:
            break
        batch.append(result)
        size += result_size
    return batch


def _is_transient(status: int) -> bool:
    return status == 429 or status >= 500


def _describe(exc: BaseException) -> str:
    message = str(exc)
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


def _clip(text: Optional[str]) -> Optional[str]:
    if text is None or len(text) <= _MAX_TEXT:
        return text
    return text[: _MAX_TEXT - 1] + "…"


# ── summary ───────────────────────────────────────────────────────────────────


def _summarize(items: List[LocalRunItem]) -> Dict[str, ScoreSummary]:
    values: Dict[str, List[Score]] = {}
    for item in items:
        for s in item.scores:
            values.setdefault(s.name or "score", []).append(s)
    summary: Dict[str, ScoreSummary] = {}
    for name, scores in values.items():
        scored = [s for s in scores if s.score is not None]
        if scored:
            mean: Optional[float] = sum(s.score for s in scored if s.score is not None) / len(scored)
            pass_rate: Optional[float] = sum(1 for s in scored if s.passed) / len(scored)
        else:
            mean = pass_rate = None
        summary[name] = ScoreSummary(name=name, mean=mean, pass_rate=pass_rate, count=len(scored))
    return summary


def _pct(value: Optional[float]) -> str:
    return "—" if value is None else f"{value * 100:.0f}%"


#: The shapes a ``task`` may have, for type checkers.
LocalTask = Union[
    Callable[[Dict[str, Any]], Any],
    Callable[[Dict[str, Any], LocalExample], Any],
    Callable[..., Awaitable[Any]],
]
