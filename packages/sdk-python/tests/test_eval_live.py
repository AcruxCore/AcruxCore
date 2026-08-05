"""Live integration test for the Evaluations SDK domain.
Requires ACRUXCORE_API_KEY and a running API at localhost:3001.
Run: python -m pytest tests/test_eval_live.py -x -v
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from acruxcore import AcruxCore

hub: AcruxCore | None = None

DATASET_NAME = "Python SDK Eval Live Test Dataset"

dataset_id: str = ""
example_id: str = ""

skip_no_key = pytest.mark.skipif(
    not os.environ.get("ACRUXCORE_API_KEY"),
    reason="ACRUXCORE_API_KEY not set",
)


@pytest.fixture(autouse=True)
def _init_hub():
    global hub
    if hub is None and os.environ.get("ACRUXCORE_API_KEY"):
        from acruxcore import AcruxCore as _AC
        hub = _AC()


@skip_no_key
@pytest.mark.asyncio
async def test_create_dataset():
    assert hub
    global dataset_id
    ds = await hub.datasets.create(name=DATASET_NAME)
    assert ds.id
    assert ds.name == DATASET_NAME
    dataset_id = ds.id


@skip_no_key
@pytest.mark.asyncio
async def test_add_example():
    assert hub
    global example_id
    ex = await hub.datasets.add_example(
        dataset_id,
        input={"question": "What is 2+2?"},
        criteria="Must answer 4",
    )
    assert ex.id
    example_id = ex.id


@skip_no_key
@pytest.mark.asyncio
async def test_get_dataset():
    assert hub
    ds = await hub.datasets.get(dataset_id)
    assert ds.id == dataset_id
    assert len(ds.examples) >= 1


@skip_no_key
@pytest.mark.asyncio
async def test_list_datasets():
    assert hub
    lst = await hub.datasets.list()
    assert isinstance(lst, list)
    assert len(lst) >= 1


@skip_no_key
@pytest.mark.asyncio
async def test_update_dataset():
    assert hub
    ds = await hub.datasets.update(dataset_id, name=f"{DATASET_NAME} (updated)")
    assert ds.name == f"{DATASET_NAME} (updated)"


@skip_no_key
@pytest.mark.asyncio
async def test_remove_example():
    assert hub
    await hub.datasets.remove_example(dataset_id, example_id)


@skip_no_key
@pytest.mark.asyncio
async def test_list_experiments():
    assert hub
    lst = await hub.experiments.list()
    assert isinstance(lst, list)


@skip_no_key
@pytest.mark.asyncio
async def test_list_runs():
    assert hub
    res = await hub.runs.list(limit=5)
    assert res.data is not None
    assert res.total >= 0


@skip_no_key
@pytest.mark.asyncio
async def test_cleanup():
    assert hub
    if dataset_id:
        await hub.datasets.delete(dataset_id)
