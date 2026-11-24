"""A FIFO buffer of pending trace reports, drained by a serial task with no timer.

``enqueue`` is synchronous: it appends and schedules the drain task, so a caller never
waits on the network and nothing is held back by a batching window. The task sends
everything currently buffered (up to ``max_batch_spans``) and, on completion, immediately
takes whatever arrived meanwhile — so an idle queue sends at once and a busy one coalesces
only while a request is already in flight.

The drain is deliberately serial. The traces ingest endpoint validates each span's
``parentSpanId`` against the spans already stored on that trace, so two requests in flight
could land a child before its parent and fail the whole batch with
``400 INVALID_SPAN_PARENT``.

When the server cannot be reached, or answers "try again later", the batch goes back to
the head of the buffer and is sent again after a growing pause (1 s, 2 s, 4 s ... up to 30 s),
so an outage or a restart loses nothing as long as the buffer has room. The buffer is the
only memory bound: past ``max_queued_spans`` the oldest spans are dropped, with one warning.
A batch the server refuses (a 4xx) is dropped at once, and one that keeps failing with a 500
is dropped after three attempts, so neither can block everything behind it. The server stores
a re-sent span once (it upserts on trace id + span id), so a retry after a reply that was lost
on the way back does not duplicate it.

Mirrors ``packages/sdk/src/span-queue.ts``: same caps, same drop-oldest policy, same retry
rules, same once-per-kind warnings, same serial drain.
"""

from __future__ import annotations

import asyncio
import random
import warnings
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple

import httpx

DEFAULT_MAX_BATCH_SPANS = 200
DEFAULT_MAX_QUEUED_SPANS = 20_000
DEFAULT_BACKOFF_INITIAL_S = 1.0
DEFAULT_BACKOFF_MAX_S = 30.0
DEFAULT_GIVE_UP_AFTER_S = 10.0

#: Attempts a batch gets when the server keeps answering 500 before it is dropped.
SERVER_ERROR_ATTEMPTS = 3

#: Statuses that mean "the server, or the proxy in front of it, is not ready yet".
_TRY_AGAIN_STATUSES = frozenset({408, 429, 502, 503, 504})

_RETRY = "retry"
_RETRY_LIMITED = "retry_limited"
_DROP = "drop"

Sender = Callable[[List[Dict[str, Any]]], Awaitable[None]]


def _span_count(payload: Dict[str, Any]) -> int:
    """Spans a trace entry carries, tolerant of an entry with no ``spans`` key."""
    return len(payload.get("spans") or [])


def _failure_action(err: BaseException) -> str:
    """Decide what a failed send means for its batch.

    - No answer at all (connection refused, reset, timeout), or 408/429/502/503/504: the
      server is down, restarting, overloaded or behind a proxy that cannot reach it. Retry
      for as long as the buffer has room.
    - Any other 5xx: the server answered and failed on this batch. Retry a few times, then
      drop it, so one batch the server cannot store never blocks the rest.
    - Any other 4xx, or an error that is not about the network: retrying cannot help. Drop.

    :param err: What the sender raised.
    :returns: ``"retry"``, ``"retry_limited"`` or ``"drop"``.
    """
    status = getattr(err, "status_code", None)
    if isinstance(status, int):
        if status in _TRY_AGAIN_STATUSES:
            return _RETRY
        return _RETRY_LIMITED if status >= 500 else _DROP
    if isinstance(err, (httpx.TransportError, OSError, asyncio.TimeoutError)):
        return _RETRY
    return _DROP


def _merge_by_trace_id(batch: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Fold entries that share a trace id into one entry of the outgoing ``traces`` array.

    Span order within each trace, and the order the traces first appeared, are both
    preserved. Entries with no trace id are left alone: each one mints its own trace
    server-side, so merging them would collapse unrelated activity into a single trace.
    Entries that set ``capturePayloads`` differently stay apart too, because the flag
    covers a whole entry: merging would apply one entry's choice to the other's spans.

    :param batch: Entries selected for one request.
    :returns: The same spans, in the same order, in as few entries as possible.
    """
    if len(batch) < 2:
        return batch

    merged: List[Dict[str, Any]] = []
    by_trace_id: Dict[Tuple[str, Optional[bool]], Dict[str, Any]] = {}

    for entry in batch:
        trace_id = entry.get("traceId")
        if not trace_id:
            merged.append(entry)
            continue
        key = (trace_id, entry.get("capturePayloads"))
        existing = by_trace_id.get(key)
        if existing is None:
            # Copied so merging never mutates what the caller handed to `enqueue`.
            copy = dict(entry)
            copy["spans"] = list(entry.get("spans") or [])
            by_trace_id[key] = copy
            merged.append(copy)
            continue
        existing["spans"].extend(entry.get("spans") or [])
        # A later entry may carry context the first lacked — a session id adopted
        # part-way through a tool loop, for instance.
        for key in ("sessionId", "name", "tags", "metadata"):
            if key not in existing and key in entry:
                existing[key] = entry[key]

    return merged


class SpanQueue:
    """Buffers trace reports and sends them off the caller's critical path.

    :param send: Coroutine performing one ``POST /traces`` for a batch. Must raise on a
        transport failure or a non-2xx response (with ``status_code`` set for the latter);
        the queue warns once per error kind and retries or drops the batch by the rules in
        the module docstring.
    :param max_batch_spans: Most spans in one request. Defaults to 200, the platform cap
        (a larger batch is rejected with ``413``). Clamped to at least 1.
    :param max_queued_spans: Most spans held in memory before the oldest are dropped.
        Defaults to 20,000, about eight minutes of a 20 request/s app with two spans per
        request. Clamped to at least 1.
    :param backoff_initial_s: Pause before the first retry; it doubles on each failure in a
        row. Defaults to 1 s.
    :param backoff_max_s: Longest pause between retries. Defaults to 30 s.
    :param give_up_after_s: How long :meth:`flush` and :meth:`close` wait on a server that
        keeps failing before they return. Defaults to 10 s. A flush that gives up leaves the
        spans queued and still retried; a close drops them, with a warning saying how many.
    """

    def __init__(
        self,
        send: Sender,
        *,
        max_batch_spans: int = DEFAULT_MAX_BATCH_SPANS,
        max_queued_spans: int = DEFAULT_MAX_QUEUED_SPANS,
        backoff_initial_s: float = DEFAULT_BACKOFF_INITIAL_S,
        backoff_max_s: float = DEFAULT_BACKOFF_MAX_S,
        give_up_after_s: float = DEFAULT_GIVE_UP_AFTER_S,
    ) -> None:
        self._send = send
        # Clamped to >= 1: a cap of 0 would make every batch empty, so the buffer could
        # never drain and flush() would never return.
        self._max_batch_spans = max(1, max_batch_spans)
        self._max_queued_spans = max(1, max_queued_spans)
        self._backoff_initial_s = max(0.0, backoff_initial_s)
        self._backoff_max_s = max(self._backoff_initial_s, backoff_max_s)
        self._give_up_after_s = max(0.0, give_up_after_s)
        # Loop time of the first failure in the current run of failures; None while healthy.
        self._failing_since: Optional[float] = None
        self._failures_in_a_row = 0
        self._head_server_errors = 0
        self._buffer: List[Dict[str, Any]] = []
        self._queued_spans = 0
        self._task: "Optional[asyncio.Task[None]]" = None
        self._task_loop: Optional[asyncio.AbstractEventLoop] = None
        self._closed = False
        self._warned_dropped = False
        self._warned_closed = False
        self._warned_errors: Set[str] = set()

    @property
    def pending_span_count(self) -> int:
        """Spans still waiting to be sent. Exposed for tests and diagnostics."""
        return self._queued_spans

    def enqueue(self, payload: Dict[str, Any]) -> None:
        """Buffer one trace report and schedule the drain task.

        Returns immediately and never raises — a telemetry problem must not surface in
        application code.

        :param payload: The trace and spans to report, the same shape ``trace()`` takes.
        """
        if self._closed:
            if not self._warned_closed:
                self._warned_closed = True
                warnings.warn(
                    "[acruxcore] trace enqueued after the client was closed — discarding",
                    stacklevel=2,
                )
            return

        self._buffer.append(payload)
        self._queued_spans += _span_count(payload)
        self._shed_overflow()
        self._wake()

    def _shed_overflow(self) -> None:
        """Drop the OLDEST entries past the cap, which keeps the most recent activity — the
        part someone debugging is actually looking at. Warns the first time only."""
        dropped = False
        while self._queued_spans > self._max_queued_spans and len(self._buffer) > 1:
            self._drop_head()
            dropped = True
        if dropped and not self._warned_dropped:
            self._warned_dropped = True
            warnings.warn(
                f"[acruxcore] trace buffer is full ({self._max_queued_spans} spans) — "
                "dropping the oldest spans",
                stacklevel=3,
            )

    def take_pending(self) -> List[Dict[str, Any]]:
        """Remove and return everything still buffered, without sending it.

        For the interpreter-exit path, which has to re-send on a fresh event loop because
        the one these entries were queued on is already closed.

        :returns: The buffered entries, oldest first.
        """
        pending = self._buffer
        self._buffer = []
        self._queued_spans = 0
        return pending

    def _drop_head(self) -> None:
        """Remove the oldest entry, keeping the span accounting straight."""
        if self._buffer:
            oldest = self._buffer.pop(0)
            self._queued_spans -= _span_count(oldest)

    def _wake(self) -> None:
        """Start the drain task unless one is already running on this loop."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # No running loop — enqueued from sync code, or after the loop closed. The
            # entries stay buffered for the next flush() or the exit drain.
            return

        if self._task is not None and self._task_loop is loop and not self._task.done():
            return
        if self._task_loop is not loop:
            # A different loop from the one the last task ran on (a new asyncio.run(), or
            # a per-test loop). That task can never be awaited from here, so let it go.
            self._task = None
        self._task_loop = loop
        self._task = loop.create_task(self._drain())

    async def _drain(self) -> None:
        """Send batches until the buffer is empty, one request in flight at a time."""
        while self._buffer:
            batch = self._take_batch()
            if not batch:
                # Unreachable: _take_batch always takes at least one entry from a
                # non-empty buffer. Dropping the head rather than continuing guarantees
                # progress, so a future change cannot turn this into a hot loop that
                # flush() waits on.
                self._drop_head()
                continue
            try:
                await self._send(batch)
            except asyncio.CancelledError:
                # asyncio.run() cancels whatever is still pending before closing the
                # loop. Put the batch back so the interpreter-exit drain can rescue it
                # instead of it disappearing with the loop.
                self._put_back(batch)
                raise
            except Exception as err:  # noqa: BLE001 — telemetry must never escape
                action = _failure_action(err)
                if action == _RETRY_LIMITED:
                    self._head_server_errors += 1
                    if self._head_server_errors >= SERVER_ERROR_ATTEMPTS:
                        action = _DROP
                retrying = action != _DROP and not self._closed
                kind = str(err) or type(err).__name__
                if kind not in self._warned_errors:
                    self._warned_errors.add(kind)
                    then = "retrying" if retrying else "continuing without it"
                    warnings.warn(f"[acruxcore] trace report failed — {then}: {kind}", stacklevel=2)
                loop = asyncio.get_running_loop()
                if self._failing_since is None:
                    self._failing_since = loop.time()
                if not retrying:
                    self._head_server_errors = 0
                    continue
                self._put_back(batch)
                self._shed_overflow()
                self._failures_in_a_row += 1
                await asyncio.sleep(self._backoff_s())
                continue
            self._failing_since = None
            self._failures_in_a_row = 0
            self._head_server_errors = 0

    def _put_back(self, batch: List[Dict[str, Any]]) -> None:
        """Return a batch to the head of the buffer, ahead of anything newer."""
        self._buffer[:0] = batch
        self._queued_spans += sum(_span_count(e) for e in batch)

    def _backoff_s(self) -> float:
        """The pause before the next attempt: doubling from the initial value up to the
        maximum, with +/-20% jitter so many clients do not retry in step."""
        base = min(self._backoff_max_s, self._backoff_initial_s * 2 ** (self._failures_in_a_row - 1))
        return base * random.uniform(0.8, 1.2)

    def _take_batch(self) -> List[Dict[str, Any]]:
        """Remove and return the next batch, honouring the span cap and merging by trace.

        Always returns at least one entry when the buffer is non-empty, so an entry on
        its own larger than the cap still makes progress instead of wedging the drain.
        """
        batch: List[Dict[str, Any]] = []
        spans = 0

        while self._buffer and spans < self._max_batch_spans:
            nxt = self._buffer[0]
            size = _span_count(nxt)
            room = self._max_batch_spans - spans

            if size <= room:
                self._buffer.pop(0)
                self._queued_spans -= size
                batch.append(nxt)
                spans += size
                continue

            # Does not fit. Leave it for the next batch if this one already has something.
            if batch:
                break

            # It is alone and still over the cap. Split it when the trace can be
            # addressed by id: the drain is serial, so the first chunk is stored before
            # the second is sent and each one appends to the same trace in order. Without
            # an id every chunk would mint a trace of its own, so send it whole and let
            # the server's 413 surface as one dropped batch.
            if not nxt.get("traceId"):
                self._buffer.pop(0)
                self._queued_spans -= size
                batch.append(nxt)
                spans += size
                break
            all_spans = nxt.get("spans") or []
            head = dict(nxt)
            head["spans"] = all_spans[:room]
            tail = dict(nxt)
            tail["spans"] = all_spans[room:]
            batch.append(head)
            self._buffer[0] = tail
            self._queued_spans -= room
            spans += room
            break

        return _merge_by_trace_id(batch)

    async def flush(self) -> None:
        """Wait until everything buffered has been sent or dropped.

        When the server keeps failing, waits at most ``give_up_after_s`` from the later of
        the first failure and the start of this call, then returns with the spans still
        queued; the drain goes on retrying them in the background.

        Never raises for a telemetry failure — those are warned about, not propagated.
        """
        loop = asyncio.get_running_loop()
        started = loop.time()
        while True:
            task = self._task
            if not self._buffer and (task is None or task.done()):
                return
            if task is None or task.done() or self._task_loop is not loop:
                self._wake()
                task = self._task
            if task is None:
                return
            if (
                self._failing_since is not None
                and loop.time() - max(self._failing_since, started) >= self._give_up_after_s
            ):
                return
            # Shielded so cancelling the caller's flush() does not cancel the drain, and
            # exceptions are swallowed because _drain already reports its own failures.
            # The short wait lets this loop notice a server that stays down.
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=0.1)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                return

    async def close(self) -> None:
        """Flush, then refuse further work. Idempotent.

        If the server is still failing when the flush gives up, what is left is dropped and
        one warning says how many spans were lost.
        """
        if self._closed:
            return
        await self.flush()
        self._closed = True
        task = self._task
        if task is not None and not task.done() and self._task_loop is asyncio.get_running_loop():
            task.cancel()  # puts an in-flight batch back, so it is counted below
            try:
                await task
            except BaseException:  # noqa: BLE001 — the cancellation we just asked for
                pass
        left = self._queued_spans
        self.take_pending()
        if left:
            warnings.warn(
                f"[acruxcore] {left} spans were not sent before the client closed: the trace "
                "server did not answer",
                stacklevel=2,
            )
