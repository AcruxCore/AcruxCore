"""Live-server tests for the Evaluations SDK domain: datasets, examples,
experiments and runs.

Boots a real ``apps/api`` subprocess via ``conftest.py``'s session-scoped
``api_server`` fixture and self-provisions its own API key, exactly like
``test_tools_lifecycle.py``. It deliberately does NOT use ``provisioned_env``:
that fixture also stands up a gateway connection and model, which needs real
OpenRouter credentials, and nothing here ever calls the gateway.

This file used to decide whether to run from ``os.environ["ACRUXCORE_API_KEY"]``
and build one module-level client. Both were wrong (issue #333). ``conftest.py``
loads the repo-root ``.env`` before collection, so in a full run the key was
always present and the tests un-skipped — against a key that had since been
revoked, so all nine 401'd. The skip guard tested whether a key *existed*, never
whether it *worked*. And the single module-level client outlived the per-test
event loops that created it, which is where the secondary
``RuntimeError: Event loop is closed`` came from. Provisioning a real key removes
the first failure and a per-test client removes the second.
"""

from __future__ import annotations

import uuid
from typing import AsyncIterator

import pytest
import pytest_asyncio
from conftest import signup_and_mint_key

from acruxcore import AcruxCore


@pytest_asyncio.fixture
async def hub(api_server: str) -> AsyncIterator[AcruxCore]:
    """A live ``AcruxCore`` client for a freshly signed-up user, one per test.

    Function-scoped, so the client never outlives the event loop it was built
    on, and so one test's ``list`` assertions cannot see another test's rows.
    """
    api_key = await signup_and_mint_key(api_server)
    client = AcruxCore(api_key=api_key, base_url=api_server, max_retries=0)
    try:
        yield client
    finally:
        await client.gateway.aclose()


@pytest.mark.asyncio
async def test_dataset_lifecycle_create_example_get_list_update_remove_delete(
    hub: AcruxCore,
) -> None:
    """The whole dataset chain in one test.

    Previously seven separate tests passing ``dataset_id``/``example_id`` through
    module-level globals, which made them order-dependent and meant one early
    failure cascaded into six confusing ones.
    """
    name = f"Python SDK Eval Live Dataset {uuid.uuid4().hex[:8]}"

    # create
    ds = await hub.datasets.create(name=name)
    assert ds.id
    assert ds.name == name

    # add_example
    example = await hub.datasets.add_example(
        ds.id,
        input={"question": "What is 2+2?"},
        criteria="Must answer 4",
    )
    assert example.id

    # add_examples — a prepared set lands in one call, with the new total
    imported = await hub.datasets.add_examples(
        ds.id,
        [
            {"input": {"question": "What is 3+3?"}, "criteria": "Must answer 6"},
            {"input": {"question": "What is 5+5?"}},
        ],
    )
    assert imported.added == 2
    assert imported.example_count == 3

    # get — the example is attached
    fetched = await hub.datasets.get(ds.id)
    assert fetched.id == ds.id
    assert len(fetched.examples) >= 1

    # list — this team's fresh dataset appears
    listed = await hub.datasets.list()
    assert isinstance(listed, list)
    assert ds.id in [d.id for d in listed]

    # update
    renamed = await hub.datasets.update(ds.id, name=f"{name} (updated)")
    assert renamed.name == f"{name} (updated)"

    # remove_example — the dataset is left with none
    await hub.datasets.remove_example(ds.id, example.id)
    emptied = await hub.datasets.get(ds.id)
    assert all(e.id != example.id for e in emptied.examples)

    # delete
    await hub.datasets.delete(ds.id)
    assert ds.id not in [d.id for d in await hub.datasets.list()]


@pytest.mark.asyncio
async def test_list_experiments_on_a_fresh_team(hub: AcruxCore) -> None:
    experiments = await hub.experiments.list()
    assert isinstance(experiments, list)


@pytest.mark.asyncio
async def test_list_runs_on_a_fresh_team(hub: AcruxCore) -> None:
    runs = await hub.runs.list(limit=5)
    assert runs.data is not None
    assert runs.total >= 0


@pytest.mark.asyncio
async def test_run_local_uploads_a_local_run_the_server_reads_back(hub: AcruxCore) -> None:
    """``experiments.run_local`` against the real server, read back through the API.

    Arranges a dataset with ``expected`` values, runs a task that gets one example
    wrong and one that raises, then checks the run list, the cell drill-down (named
    scores, 0–100, and ``expected``), the report's ``namedScores`` and the trace the
    SDK filed for each example.
    """
    ds = await hub.datasets.create(name=f"Local run {uuid.uuid4().hex[:8]}")
    await hub.datasets.add_examples(
        ds.id,
        [
            {"input": {"n": 1}, "expected": {"double": 2}},
            {"input": {"n": 2}, "expected": {"double": 4}},
            {"input": {"n": 3}, "expected": {"double": 6}},
        ],
    )
    got = await hub.datasets.get(ds.id)
    assert sorted(e.expected["double"] for e in got.examples) == [2, 4, 6]

    def task(inp, ctx):  # type: ignore[no-untyped-def]
        if inp["n"] == 3:
            raise ValueError("three is not supported")
        return {"double": inp["n"] * 2 if inp["n"] == 1 else 0}

    def exact(output, expected):  # type: ignore[no-untyped-def]
        return output == expected

    def closeness(output, expected):  # type: ignore[no-untyped-def]
        return {"score": 1 - abs(output["double"] - expected["double"]) / 10, "reason": "distance"}

    result = await hub.experiments.run_local(
        ds.id, task=task, scorers=[exact, closeness], name="sdk-live", metadata={"git_sha": "abc"}
    )

    assert result.status == "succeeded"
    assert len(result.items) == 3
    assert result.summary["exact"].mean == 0.5 and result.summary["exact"].count == 2
    errored = [i for i in result.items if i.error]
    assert len(errored) == 1 and errored[0].error == "ValueError: three is not supported"

    runs = await hub.runs.list(dataset_id=ds.id)
    assert [r.kind for r in runs.data] == ["local"]

    cell = await hub.runs.get_cell(result.run_id, "sdk-live|local")
    rows = {json_key(r["input"]): r for r in cell.examples}
    wrong = rows["2"]
    assert wrong["expected"] == {"double": 4}
    named = {s["name"]: s for s in wrong["scores"]}
    assert named["exact"]["score"] == 0 and named["exact"]["passed"] is False
    assert named["closeness"]["score"] == 60 and named["closeness"]["reason"] == "distance"

    report = await hub.runs.get_report(result.run_id)
    names = {n["name"] for n in report.cells[0]["namedScores"]}
    assert names == {"exact", "closeness"}

    trace_id = next(i.trace_id for i in result.items if i.input["n"] == 1)
    assert trace_id
    trace = await hub.traces.get(trace_id)
    assert [s.kind for s in trace.spans] == ["chain"]


def json_key(value):  # type: ignore[no-untyped-def]
    """Key a cell row by its example's ``n`` so the assertions read by example."""
    return str(value.get("n"))
