"""``AcruxCoreSync`` — the same client for code that is not async.

It owns one :class:`~acruxcore.client.AcruxCore` and one event loop running on a
background thread. Each method call is sent to that loop and the calling thread waits
for the result, so the namespaces, arguments and return values are exactly those of the
async client. A streaming result becomes a plain iterator.

The open :meth:`~acruxcore.traces_api.TracesNamespace.step` is carried across to the
loop with each call. Context variables do not cross threads on their own, and without
this a ``gateway.chat()`` inside a step would not know the step it ran in.
"""

from __future__ import annotations

import asyncio
import inspect
import threading
import weakref
from typing import Any, AsyncIterator, Awaitable, Callable

from .client import AcruxCore
from .errors import VALIDATION_ERROR, AcruxCoreError
from .steps import current_frame, reset_current_frame, set_current_frame

#: Namespaces exposed on the sync client, the same names as on :class:`AcruxCore`.
_NAMESPACES = (
    "prompts", "gateway", "traces", "tools", "sessions",
    "datasets", "experiments", "runs", "optimize",
)


class _SyncIterator:
    """A plain iterator over an async iterator that lives on the client's loop.

    Leaving a ``for`` loop early does not close an iterator, so the async one would stay
    suspended on the loop with its HTTP stream open. It is closed when this object is
    dropped, or at once by :meth:`close` or a ``with`` block.
    """

    def __init__(
        self,
        source: AsyncIterator[Any],
        run: Callable[[Callable[[], Awaitable[Any]]], Any],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._source = source
        self._run = run
        self._loop = loop
        self._done = False

    def __iter__(self) -> "_SyncIterator":
        return self

    def __next__(self) -> Any:
        if self._done:
            raise StopIteration
        try:
            return self._run(self._source.__anext__)
        except StopAsyncIteration:
            self._done = True
            raise StopIteration from None

    def close(self) -> None:
        """Stop early: release the stream now and wait for it. Idempotent."""
        if self._done:
            return
        self._done = True
        aclose = getattr(self._source, "aclose", None)
        if aclose is not None:
            self._run(aclose)

    def __enter__(self) -> "_SyncIterator":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def __del__(self) -> None:
        # No waiting here: a finaliser can run on any thread, the loop's own included.
        aclose = getattr(self._source, "aclose", None)
        if self._done or aclose is None or self._loop.is_closed():
            return
        try:
            asyncio.run_coroutine_threadsafe(aclose(), self._loop)
        except RuntimeError:
            pass  # the loop stopped between the check and the call; nothing is left to close


class _SyncNamespace:
    """Wraps one async namespace: every coroutine method becomes a blocking one."""

    def __init__(
        self,
        target: Any,
        run: Callable[[Callable[[], Awaitable[Any]]], Any],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._target = target
        self._run = run
        self._loop = loop

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._target, name)
        if not inspect.iscoroutinefunction(attr):
            return attr

        def call(*args: Any, **kwargs: Any) -> Any:
            result = self._run(lambda: attr(*args, **kwargs))
            if hasattr(result, "__aiter__"):
                return _SyncIterator(result, self._run, self._loop)
            return result

        call.__name__ = name
        call.__doc__ = attr.__doc__
        return call


class AcruxCoreSync:
    """Blocking client for AcruxCore — for scripts, Flask/Django apps, and notebooks.

    Takes exactly the arguments of :class:`~acruxcore.client.AcruxCore` and exposes the
    same namespaces, with every ``await``-able method made blocking::

        from acruxcore import AcruxCoreSync

        hub = AcruxCoreSync()  # ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL

        @hub.traces.step("handle-ticket", kind="agent")
        def handle(ticket: str) -> str:
            version = hub.prompts.get_by_alias("triage", "production")
            return hub.gateway.chat("gpt-4o-mini", messages, prompt_version_id=version.id).content

    Safe to share across threads; each thread's steps form their own trace. Buffered
    traces are sent when :meth:`close` runs — on ``with`` exit, or at interpreter exit.

    Do not call it from code the SDK itself runs on its loop — a sync tool function
    handed to ``run_tool_loop``, for instance. That call would wait on the loop it is
    blocking, so it raises ``VALIDATION_ERROR`` instead of hanging.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever, name="acruxcore-sync", daemon=True
        )
        self._thread.start()
        self._closed = False
        try:
            self._async = AcruxCore(*args, **kwargs)
        except BaseException:
            self._stop_loop()
            raise

        queue = self._async._span_queue
        loop = self._loop
        # The span queue is not thread-safe and drains on the loop that enqueued, so a
        # finished root step is handed to the loop thread rather than enqueued here. It
        # captures the loop, not `self`: the async client holds this sink, and the
        # finaliser below holds the async client.
        self._async.traces._step_sink = lambda payload: loop.call_soon_threadsafe(
            queue.enqueue, dict(payload)
        )

        for name in _NAMESPACES:
            setattr(self, name, _SyncNamespace(getattr(self._async, name), self._run, loop))

        # Runs on close(), when the client is garbage-collected, or at interpreter exit —
        # whichever comes first, once. Without the middle case a client dropped without
        # close() kept its thread, loop and connection pool alive for good.
        self._finalizer = weakref.finalize(self, _shutdown, loop, self._thread, self._async)

    def _run(self, make: Callable[[], Awaitable[Any]]) -> Any:
        """Run one coroutine on the client's loop and wait for its result."""
        if self._closed:
            raise AcruxCoreError("acruxcore: this AcruxCoreSync client is closed", VALIDATION_ERROR)
        if threading.current_thread() is self._thread:
            raise AcruxCoreError(
                "acruxcore: AcruxCoreSync was called from code the SDK runs on its own event "
                "loop (a sync tool function, for instance), which would wait forever. Make "
                "that function async and use the async AcruxCore client inside it.",
                VALIDATION_ERROR,
            )
        frame = current_frame()

        async def in_caller_step() -> Any:
            token = set_current_frame(frame)
            try:
                return await make()
            finally:
                reset_current_frame(token)

        return asyncio.run_coroutine_threadsafe(in_caller_step(), self._loop).result()

    def flush(self) -> None:
        """Send every buffered trace now and wait for it — before reading one back."""
        self._run(self._async.traces.flush)

    def close(self) -> None:
        """Send buffered traces, close the connection pool and stop the loop. Idempotent."""
        if self._closed:
            return
        if threading.current_thread() is self._thread:
            self._run(self._async.aclose)  # raises: see _run
        self._closed = True
        self._finalizer()

    def _stop_loop(self) -> None:
        _stop_loop(self._loop, self._thread)

    def __enter__(self) -> "AcruxCoreSync":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # Typed attributes for editors; set per instance in __init__.
    prompts: Any
    gateway: Any
    traces: Any
    tools: Any
    sessions: Any
    datasets: Any
    experiments: Any
    runs: Any
    optimize: Any


def _stop_loop(loop: asyncio.AbstractEventLoop, thread: threading.Thread) -> None:
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    if not thread.is_alive():
        loop.close()


def _shutdown(loop: asyncio.AbstractEventLoop, thread: threading.Thread, client: AcruxCore) -> None:
    """Flush and close ``client`` on its loop, then stop the loop. Takes no reference to
    the :class:`AcruxCoreSync` itself, so it can run once that object is gone."""
    if loop.is_closed():
        return
    if threading.current_thread() is thread:
        # Collected on the loop's own thread: waiting here would block the loop it waits
        # on. Schedule the flush and the stop instead; the loop runs them in order.
        loop.create_task(client.aclose()).add_done_callback(lambda _: loop.stop())
        return
    try:
        asyncio.run_coroutine_threadsafe(client.aclose(), loop).result(timeout=30)
    finally:
        _stop_loop(loop, thread)


__all__ = ["AcruxCoreSync"]
