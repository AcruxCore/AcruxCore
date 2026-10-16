"""``client.traces.step`` — trace your app's own steps, with model calls nested under them.

A step is one span the SDK writes for a piece of your code: a retrieval, a parse, a
whole request handler. Steps nest through a :class:`contextvars.ContextVar`, so a step
opened inside another step becomes its child, and a ``gateway.chat()`` or
``gateway.stream()`` made inside a step joins that step's trace as its child too.

The whole tree of one outermost ("root") step is sent as one trace report when the
root step ends. That is deliberate rather than an optimisation. ``POST /traces``
rejects a span whose ``parentSpanId`` is not stored yet, and a step always ends after
the calls inside it — so sending each span as it ends would send every child before
its parent. A gateway call is the exception: the gateway writes its ``llm`` span
server-side at once, pointing at the step's id, and the trace view links it to the
step when the step arrives.

A report is routed to its root by the trace id it names, not by the caller's context, so
a stream read after its step ended still finds the step. A step still open when its root
is sent keeps buffering its own subtree and sends it when it ends.

Steps belong to the client that opened them. A call made on another client inside a step
does not join it: that client may hold another team's key, and its spans would be posted
into a trace it cannot see. One root holds at most :data:`MAX_STEP_SPANS` spans; past
that, new spans are dropped and counted on the root span as ``droppedSpans``. Every
change to a root takes one lock, because :class:`~acruxcore.sync_client.AcruxCoreSync`
closes steps on the caller's thread while reports arrive on its loop thread.
"""

from __future__ import annotations

import contextvars
import functools
import inspect
import json
import threading
import uuid
import warnings
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Iterator, List, Optional, Set, TypeVar, cast

from .types import IngestSpan, SpanKind, TraceInput

F = TypeVar("F", bound=Callable[..., Any])

#: Sends a finished root step's trace report. The async client enqueues it on its span
#: queue; the sync client hands it to its own event loop first.
Sink = Callable[[TraceInput], None]

#: Sentinel for "the caller did not set an output", so ``None`` stays a real output.
_UNSET: Any = object()

#: Most spans one root holds before it drops new ones. Half the span queue's default
#: limit (2000), so a finished tree still fits in the queue beside other traffic: an
#: entry larger than the queue's limit is the first one its drop-oldest rule discards.
MAX_STEP_SPANS = 1000

#: Guards every root and the map of roots. Re-entrant, because a sink may report again.
_lock = threading.RLock()


@dataclass
class _Root:
    """What every step of one trace shares: the id, the name, and the spans so far."""

    trace_id: str
    name: str
    sink: Sink
    #: The client this trace belongs to — its span queue. Only that client's calls join.
    owner: Any = None
    session_id: Optional[str] = None
    tags: Optional[List[str]] = None
    metadata: Optional[Dict[str, Any]] = None
    spans: List[IngestSpan] = field(default_factory=list)
    #: Routed reports that set ``capturePayloads``. That flag applies to a whole trace
    #: entry, so they travel as entries of their own, sent right after the root's.
    riders: List[TraceInput] = field(default_factory=list)
    #: Span ids of the steps still open on this trace.
    open: Set[str] = field(default_factory=set)
    #: Set once the root step ended and its report was handed to the sink. A report
    #: arriving later is sent on its own, unless it hangs under a step still open.
    sent: bool = False
    #: Spans dropped over :data:`MAX_STEP_SPANS`, and their ids, so a child of a dropped
    #: span is dropped too rather than sent pointing at a parent that never arrives.
    dropped: int = 0
    dropped_ids: Set[str] = field(default_factory=set)
    #: Every ``parentSpanId`` a buffered span names: a step with buffered children is
    #: kept over the limit, or those children would be rejected for a missing parent.
    parents: Set[str] = field(default_factory=set)


@dataclass
class _Frame:
    """One entry into a step: its span id, its root, and what this entry recorded.

    Kept per entry rather than on the :class:`Step`, so one step object can be entered
    again, or by two tasks at once, without one entry overwriting the other.
    """

    span_id: str
    root: _Root
    step: Optional["Step"] = None
    #: The frame that was current when this one opened, whichever client it belongs to.
    outer: Optional["_Frame"] = None
    parent_span_id: Optional[str] = None
    start: str = ""
    input: Any = None
    output: Any = _UNSET
    token: "Optional[contextvars.Token[Optional[_Frame]]]" = None


_current: "contextvars.ContextVar[Optional[_Frame]]" = contextvars.ContextVar(
    "acruxcore_current_step", default=None
)

#: Roots that may still take spans, by trace id. Routing by the trace a report names,
#: not by the caller's context, is what lets a stream read after its step ended — or a
#: call handed the step's ``trace_id`` — still join the buffer.
_roots: Dict[str, _Root] = {}


def current_frame() -> Optional[_Frame]:
    """The innermost open step in this context, or ``None`` outside any step."""
    return _current.get()


def set_current_frame(frame: Optional[_Frame]) -> "contextvars.Token[Optional[_Frame]]":
    """Make ``frame`` the open step for this context — used by the sync client, which
    runs each call on another thread's event loop and so must carry the step across."""
    return _current.set(frame)


def reset_current_frame(token: "contextvars.Token[Optional[_Frame]]") -> None:
    """Undo :func:`set_current_frame`."""
    _current.reset(token)


def _nearest(owner: Any) -> Optional[_Frame]:
    """The innermost open step of ``owner``'s client in this context."""
    frame = _current.get()
    while frame is not None and frame.root.owner is not owner:
        frame = frame.outer
    return frame


def join_step(trace: Any, owner: Any = None) -> Any:
    """Fill a ``chat()`` call's ``trace`` option from the open step, if there is one.

    An explicit ``trace=False`` still opts out, and any key the caller set wins, so a
    call can still report to another trace from inside a step.

    :param trace: The caller's ``trace`` option: ``None``, a bool, or a dict.
    :param owner: The calling client's span queue. Only that client's steps are joined.
    :returns: The option to use — unchanged outside a step of this client.
    """
    frame = _nearest(owner)
    if frame is None or trace is False:
        return trace
    conf: Dict[str, Any] = dict(trace) if isinstance(trace, dict) else {}
    if conf.get("trace_id") in (None, frame.root.trace_id):
        conf["trace_id"] = frame.root.trace_id
        conf.setdefault("parent_span_id", frame.span_id)
        # Offered, not asserted: the gateway names the trace after the root step only
        # when nothing has named it yet, which is what a call that joins a trace wants.
        conf.setdefault("_default_name", frame.root.name)
        if frame.root.session_id:
            conf.setdefault("session_id", frame.root.session_id)
    return conf


def route_report(payload: TraceInput, owner: Any = None) -> bool:
    """Add a trace report to the open root step instead of sending it now, when it
    belongs to that step's trace.

    Called on every report the SDK makes. A BYO ``llm`` span points at a step that is
    not stored yet, so it must travel in the same request as that step, or the server
    rejects it.

    :param payload: A trace report about to be enqueued.
    :param owner: The reporting client's span queue. Another client's root never takes it.
    :returns: ``True`` when the open step took it; the caller must not send it then.
    """
    trace_id = payload.get("traceId")
    with _lock:
        root = _roots.get(trace_id) if trace_id else None
        if root is None or root.owner is not owner:
            return False
        spans = list(payload.get("spans") or [])
        # After the root was sent, only a report that hangs under a still-open step must
        # wait; anything else can go now, behind the root that is already queued.
        if root.sent:
            held = _open_checker(root, spans)
            if not any(held(s) for s in spans):
                return False
        kept = [s for s in _parent_first(spans) if _keep(root, s)]
        if "capturePayloads" in payload:
            root.riders.append({
                "traceId": root.trace_id,
                "capturePayloads": payload["capturePayloads"],
                "spans": kept,
            })
        else:
            root.spans.extend(kept)
        # The rest is trace-level, merged the way a nested step's own values are. The
        # name is left alone: the root step names the trace.
        _merge_trace_context(root, payload.get("tags"), payload.get("metadata"), payload.get("sessionId"))
        return True


def step_trace_name(trace_id: Optional[str]) -> Optional[str]:
    """The open root step's name when ``trace_id`` is that step's trace, else ``None``.

    For calls that take an explicit ``trace_id`` rather than joining the step, so the
    name they offer for a new trace is still the step's.
    """
    root = _roots.get(trace_id) if trace_id else None
    return root.name if root else None


def _merge_trace_context(
    root: _Root,
    tags: Optional[List[str]],
    metadata: Optional[Dict[str, Any]],
    session_id: Optional[str],
) -> None:
    """Add tags, metadata and a session to the trace rather than dropping them."""
    if tags:
        root.tags = list(dict.fromkeys((root.tags or []) + list(tags)))
    if metadata:
        root.metadata = {**(root.metadata or {}), **metadata}
    if session_id and not root.session_id:
        root.session_id = session_id


def _buffered(root: _Root) -> int:
    return len(root.spans) + sum(len(r.get("spans") or []) for r in root.riders)


#: Warned once per process: a trace over :data:`MAX_STEP_SPANS` lost spans.
_warned_cap = False


def _keep(root: _Root, span: IngestSpan, always: bool = False) -> bool:
    """Whether ``span`` may join the root's buffer; counts it as dropped when not.

    Over the limit a span is still kept when it is the root step (``always``) or a step
    that buffered spans point at — dropping either would orphan spans already kept.
    """
    global _warned_cap
    parent = span.get("parentSpanId")
    keep = (
        always
        or span["spanId"] in root.parents
        or (parent not in root.dropped_ids and _buffered(root) < MAX_STEP_SPANS)
    )
    if keep:
        if parent:
            root.parents.add(parent)
        return True
    root.dropped += 1
    root.dropped_ids.add(span["spanId"])
    if not _warned_cap:
        _warned_cap = True
        warnings.warn(
            f"[acruxcore] a step trace passed {MAX_STEP_SPANS} spans — dropping the rest "
            "(counted as droppedSpans on its root span)",
            stacklevel=3,
        )
    return False


def _open_checker(root: _Root, extra: Optional[List[IngestSpan]] = None) -> Callable[[IngestSpan], bool]:
    """A test for "this span hangs, through spans not yet sent, under a step still open",
    so it cannot be sent before that step is.

    Builds the parent map once and remembers each ancestor's answer, so checking every
    span of a tree costs time in proportion to the tree, not to its square.
    """
    parent_of: Dict[str, Optional[str]] = {}
    for s in [*root.spans, *(sp for r in root.riders for sp in r.get("spans") or []), *(extra or [])]:
        parent_of[s["spanId"]] = s.get("parentSpanId")
    memo: Dict[str, bool] = {}

    def under_open(span: IngestSpan) -> bool:
        path: List[str] = []
        node = span.get("parentSpanId")
        result = False
        while node:
            if node in memo:
                result = memo[node]
                break
            if node in root.open:
                result = True
                break
            if node in path:  # a cycle names no open step
                break
            path.append(node)
            node = parent_of.get(node)
        for seen in path:
            memo[seen] = result
        return result

    return under_open


def _flush(root: _Root) -> None:
    """Send everything the root holds that no open step is still above.

    The first flush is the root's own report and names the trace. A step that was still
    open then keeps buffering its subtree, and the next flush sends it when that step ends.
    The buffer is cut under the lock; the sink is called after it is released.
    """
    with _lock:
        first = not root.sent
        held_back = _open_checker(root)
        ready: List[IngestSpan] = []
        held: List[IngestSpan] = []
        for s in root.spans:
            (held if held_back(s) else ready).append(s)
        ready_riders = [r for r in root.riders if not any(held_back(s) for s in r.get("spans") or [])]
        root.riders = [r for r in root.riders if r not in ready_riders]
        root.spans = held
        root.sent = True
        if not root.open:
            _roots.pop(root.trace_id, None)
        payloads: List[TraceInput] = []
        if first or ready:
            payload: TraceInput = {"traceId": root.trace_id, "spans": _parent_first(ready)}
            if first:
                payload["name"] = root.name
            if root.session_id:
                payload["sessionId"] = root.session_id
            if root.tags:
                payload["tags"] = root.tags
            if root.metadata:
                payload["metadata"] = root.metadata
            payloads.append(payload)
        for rider in ready_riders:
            payloads.append({**rider, "spans": _parent_first(list(rider.get("spans") or []))})

    try:
        for item in payloads:
            root.sink(item)
    except Exception as err:  # noqa: BLE001 — telemetry must never break the app
        _warn_sink_failure(err)


def _parent_first(spans: List[IngestSpan]) -> List[IngestSpan]:
    """``spans`` reordered so each parent comes before its children.

    Spans are recorded as they end, so a child is always ahead of its parent. That is
    fine in one request, but the span queue splits a report over its 200-span cap, and a
    chunk whose spans point at parents in a later chunk is rejected whole. Siblings keep
    their order; a span whose parent is not in the list (one the gateway already
    stored) counts as a top-level span.
    """
    ids = {s["spanId"] for s in spans}
    children: Dict[Optional[str], List[IngestSpan]] = {}
    for s in spans:
        parent = s.get("parentSpanId")
        children.setdefault(parent if parent in ids else None, []).append(s)
    out: List[IngestSpan] = []
    stack = list(reversed(children.get(None, [])))
    while stack:
        span = stack.pop()
        out.append(span)
        stack.extend(reversed(children.get(span["spanId"], [])))
    return out


#: Sink failures already warned about, by message — one warning per kind, as the span
#: queue does, so a broken sink cannot flood the app's logs.
_warned_sink_errors: Set[str] = set()


def _warn_sink_failure(err: Exception) -> None:
    kind = str(err) or type(err).__name__
    if kind not in _warned_sink_errors:
        _warned_sink_errors.add(kind)
        warnings.warn(f"[acruxcore] step trace could not be queued — dropping it: {kind}", stacklevel=3)


def _jsonable(value: Any) -> Any:
    """``value`` as plain JSON, with anything JSON cannot hold turned into its ``repr``.

    The span queue serialises a whole batch at once, so one unserialisable argument
    would otherwise lose every span in that batch, not only this one.
    """
    try:
        return json.loads(json.dumps(value, default=repr))
    except (TypeError, ValueError):
        return repr(value)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Step:
    """One step of your app, used as a decorator or as a context manager.

    Made by :meth:`~acruxcore.traces_api.TracesNamespace.step`; see there for the
    arguments. As a context manager it yields itself, so a block can set
    :attr:`output` (and read :attr:`span_id` / :attr:`trace_id`) while it runs.

    What one entry records lives with that entry, not on this object, so the same step
    may be entered again, or by several tasks or threads at once.
    """

    def __init__(
        self,
        name: str,
        *,
        kind: SpanKind,
        sink: Sink,
        input: Any = None,
        capture_input: bool = True,
        capture_output: bool = True,
        session_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        metadata: Optional[Dict[str, Any]] = None,
        owner: Any = None,
    ) -> None:
        self.name = name
        self.kind = kind
        self.input = input
        self._sink = sink
        self._owner = owner
        self._capture_input = capture_input
        self._capture_output = capture_output
        self._session_id = session_id
        self._tags = tags
        self._metadata = metadata
        #: The most recent entry, for reading ``span_id`` / ``output`` after a block ends.
        self._last: Optional[_Frame] = None

    def _active(self) -> Optional[_Frame]:
        """This step's innermost open entry in the current context."""
        frame = _current.get()
        while frame is not None and frame.step is not self:
            frame = frame.outer
        return frame

    def _entry(self) -> Optional[_Frame]:
        return self._active() or self._last

    @property
    def output(self) -> Any:
        """What the step produced, for the entry open in this context. A decorated
        function's return value is set for you; a ``with`` block sets it by hand."""
        frame = self._entry()
        return None if frame is None or frame.output is _UNSET else frame.output

    @output.setter
    def output(self, value: Any) -> None:
        frame = self._entry()
        if frame is not None:
            frame.output = value

    @property
    def span_id(self) -> Optional[str]:
        """This step's span id while it is open (and after), else ``None``."""
        frame = self._entry()
        return frame.span_id if frame else None

    @property
    def trace_id(self) -> Optional[str]:
        """The trace this step reports to, once it has opened."""
        frame = self._entry()
        return frame.root.trace_id if frame else None

    # ── open / close ───────────────────────────────────────────────────────

    def _open(self, input: Any = _UNSET, detached: bool = False) -> _Frame:
        """Open one entry. ``detached`` leaves it not current — for a generator, whose
        body runs in pieces: the wrapper makes it current only while the body runs, so
        code that consumes the generator between items is not traced as part of it."""
        outer = _current.get()
        parent = _nearest(self._owner)
        with _lock:
            root = parent.root if parent else _Root(
                trace_id=str(uuid.uuid4()), name=self.name, sink=self._sink, owner=self._owner,
                session_id=self._session_id, tags=self._tags, metadata=self._metadata,
            )
            if parent:
                # Tags, metadata and a session belong to the trace, so a nested step adds
                # its own to the trace rather than having them silently ignored.
                _merge_trace_context(root, self._tags, self._metadata, self._session_id)
            frame = _Frame(
                span_id=str(uuid.uuid4()), root=root, step=self, outer=outer,
                parent_span_id=parent.span_id if parent else None, start=_now_iso(),
                input=self.input if input is _UNSET else input,
            )
            root.open.add(frame.span_id)
            # Back in the map if its root was already sent and removed: a step opened
            # late still buffers what it holds.
            _roots.setdefault(root.trace_id, root)
        self._last = frame
        if not detached:
            frame.token = _current.set(frame)
        return frame

    def _close(self, frame: _Frame, error: Optional[BaseException]) -> None:
        if frame.token is not None:
            _current.reset(frame.token)
            frame.token = None
        span: IngestSpan = {
            "spanId": frame.span_id,
            "name": self.name,
            "kind": self.kind,
            "status": "error" if error is not None else "ok",
            "startTime": frame.start,
            "endTime": _now_iso(),
        }
        if frame.parent_span_id:
            span["parentSpanId"] = frame.parent_span_id
        if self._capture_input and frame.input is not None:
            span["input"] = _jsonable(frame.input)
        if self._capture_output and frame.output is not _UNSET:
            span["output"] = _jsonable(frame.output)
        if error is not None:
            span["error"] = repr(error)
        root = frame.root
        is_root = frame.parent_span_id is None
        with _lock:
            if is_root and root.dropped:
                span["attributes"] = {"droppedSpans": root.dropped}
            root.open.discard(frame.span_id)
            if _keep(root, span, always=is_root):
                root.spans.append(span)
            flush = is_root or root.sent
            if flush:
                # Re-registered so reports under a step that is still open keep finding it.
                _roots[root.trace_id] = root
        if flush:
            _flush(root)

    async def _await_in(self, frame: _Frame, awaitable: Awaitable[Any]) -> Any:
        """Await what a plain function returned, with the step open around it."""
        token = _current.set(frame)
        try:
            frame.output = await awaitable
        except BaseException as err:
            _current.reset(token)
            self._close(frame, err)
            raise
        _current.reset(token)
        self._close(frame, None)
        return frame.output

    # ── context manager ────────────────────────────────────────────────────

    def __enter__(self) -> "Step":
        self._open()
        return self

    def __exit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> None:
        self._close(cast(_Frame, self._active() or self._last), exc)

    async def __aenter__(self) -> "Step":
        self._open()
        return self

    async def __aexit__(self, exc_type: Any, exc: Optional[BaseException], tb: Any) -> None:
        self._close(cast(_Frame, self._active() or self._last), exc)

    # ── decorator ──────────────────────────────────────────────────────────

    def _bind_input(self, fn: Callable[..., Any], args: Any, kwargs: Any) -> Any:
        if self.input is not None or not self._capture_input:
            return self.input
        try:
            bound = inspect.signature(fn).bind(*args, **kwargs)
        except (TypeError, ValueError):
            return {"args": list(args), "kwargs": kwargs}
        arguments = dict(bound.arguments)
        # A method's receiver is rarely useful on a span and often unserialisable.
        arguments.pop("self", None)
        arguments.pop("cls", None)
        return arguments

    def __call__(self, fn: F) -> F:
        if inspect.isasyncgenfunction(fn):

            @functools.wraps(fn)
            async def async_gen_wrapper(*args: Any, **kwargs: Any) -> Any:
                agen = fn(*args, **kwargs)
                frame = self._open(self._bind_input(fn, args, kwargs), detached=True)
                # Values passed to asend() and exceptions passed to athrow() are handed
                # on to the inner generator, so decorating one changes nothing it sees.
                sent: Any = None
                thrown: Optional[BaseException] = None
                try:
                    while True:
                        token = _current.set(frame)
                        try:
                            if thrown is not None:
                                exc, thrown = thrown, None
                                item = await agen.athrow(exc)
                            else:
                                item = await agen.asend(sent)
                        except StopAsyncIteration:
                            break
                        finally:
                            _current.reset(token)
                        sent = None
                        try:
                            sent = yield item
                        except GeneratorExit:
                            raise
                        except BaseException as exc:
                            thrown = exc
                except BaseException as err:
                    await agen.aclose()
                    self._close(frame, None if isinstance(err, GeneratorExit) else err)
                    raise
                self._close(frame, None)

            return cast(F, async_gen_wrapper)

        if inspect.isgeneratorfunction(fn):

            @functools.wraps(fn)
            def gen_wrapper(*args: Any, **kwargs: Any) -> Iterator[Any]:
                gen = fn(*args, **kwargs)
                frame = self._open(self._bind_input(fn, args, kwargs), detached=True)
                sent: Any = None
                thrown: Optional[BaseException] = None
                try:
                    while True:
                        token = _current.set(frame)
                        try:
                            if thrown is not None:
                                exc, thrown = thrown, None
                                item = gen.throw(exc)
                            else:
                                item = gen.send(sent)
                        except StopIteration as stop:
                            result = stop.value
                            break
                        finally:
                            _current.reset(token)
                        sent = None
                        try:
                            sent = yield item
                        except GeneratorExit:
                            raise
                        except BaseException as exc:
                            thrown = exc
                except BaseException as err:
                    gen.close()
                    self._close(frame, None if isinstance(err, GeneratorExit) else err)
                    raise
                self._close(frame, None)
                return result

            return cast(F, gen_wrapper)

        if inspect.iscoroutinefunction(fn):

            @functools.wraps(fn)
            async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
                frame = self._open(self._bind_input(fn, args, kwargs))
                try:
                    frame.output = await fn(*args, **kwargs)
                except BaseException as err:
                    self._close(frame, err)
                    raise
                self._close(frame, None)
                return frame.output

            return cast(F, async_wrapper)

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            frame = self._open(self._bind_input(fn, args, kwargs))
            try:
                result = fn(*args, **kwargs)
            except BaseException as err:
                self._close(frame, err)
                raise
            if inspect.isawaitable(result):
                # An async function that does not look like one — wrapped by a plain
                # decorator, or an object with an async __call__. The step stays open
                # until the result is awaited, and is current while it runs.
                if frame.token is not None:
                    _current.reset(frame.token)
                    frame.token = None
                return self._await_in(frame, result)
            frame.output = result
            self._close(frame, None)
            return result

        return cast(F, wrapper)
