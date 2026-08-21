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
