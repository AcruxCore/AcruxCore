"""Live integration tests for `client.prompts` (`PromptsNamespace`) — Python
mirror of the Node SDK's `packages/sdk/test/integration/prompts.integration.test.ts`.

Like `test_byo_integration.py`, this boots a REAL `apps/api` server as a
subprocess (see `conftest.py`'s `api_server` fixture) and drives it with a real
`AcruxCore` client over real HTTP — prompt-lifecycle calls go through
`self._client._request` -> real `httpx`, so there is no in-process shortcut
available to Python the way Node's supertest-in-process integration test has.

Deliberately does NOT depend on `conftest.py`'s `provisioned_env`/`hub`
fixtures: those self-provision a real OpenRouter gateway connection and
`pytest.skip()` the whole suite when `ACRUXCORE_TEST_PROVIDER_BASE_URL`/
`ACRUXCORE_TEST_PROVIDER_API_KEY` aren't set, neither of which prompt/version
CRUD, diff, alias, export/import or traces-for-version needs. This file's own
`prompts_api_key`/`hub` fixtures below do only the sign-up + API-key mint (the
same two `httpx` calls `provisioned_env` makes for that part) and stop there.

CONCURRENCY WARNING: same caveat as `test_byo_integration.py` — do not run
this file at the same time as `npm test` or another live integration suite
against the same `TEST_DATABASE_URL`. See `conftest.py`'s module docstring.
"""

from __future__ import annotations

import uuid
from typing import Any, Iterator

import httpx
import pytest
import pytest_asyncio

from acruxcore import API_ERROR, AcruxCore, AcruxCoreError

# Every test below is async and shares one event loop for the whole module, so
# the session-scoped `hub` fixture's underlying httpx.AsyncClient is only ever
# used from the loop it was created in — mirrors `test_byo_integration.py`.
pytestmark = pytest.mark.asyncio(loop_scope="session")

# Password used for the one test account this file creates. Never leaves this process.
_TEST_PASSWORD = "test-password-not-a-real-one-1234"


def _session_cookie(response: httpx.Response) -> str:
    """Extracts the `name=value` session cookie pair from a sign-up response.

    Copied from `conftest.py`'s identical helper rather than imported: this
    file intentionally does not reuse anything from `provisioned_env` beyond
    the plain sign-up/key-mint HTTP calls themselves.
    """
    raw = response.headers.get("set-cookie")
    if not raw or "session_token" not in raw:
        raise RuntimeError(
            f"No session cookie in sign-up response (status {response.status_code}): "
            f"{response.text}"
        )
    return raw.split(";")[0]


@pytest.fixture(scope="session")
def prompts_api_key(api_server: str) -> str:
    """Self-provisions a fresh user + personal API key on the live server.

    Lighter than `conftest.py`'s `provisioned_env`: no prompt, gateway
    connection, model or tool provisioning — this suite only exercises
    `client.prompts`, which needs none of that.

    :param api_server: The running server's base URL (session-scoped fixture
        from `conftest.py`).
    :returns: A freshly minted personal API key.
    """
    with httpx.Client(base_url=api_server, timeout=30.0) as c:
        email = f"test-prompts-{uuid.uuid4()}@example.com"
        signup = c.post(
            "/auth/sign-up/email",
            json={"email": email, "password": _TEST_PASSWORD, "name": "Prompts Test User"},
        )
        if signup.status_code != 200:
            raise RuntimeError(f"sign-up failed ({signup.status_code}): {signup.text}")
        cookie = _session_cookie(signup)

        key_res = c.post(
            "/api-keys", json={"name": "prompts lifecycle test key"}, headers={"Cookie": cookie}
        )
        if key_res.status_code != 201:
            raise RuntimeError(
                f"api-key creation failed ({key_res.status_code}): {key_res.text}"
            )
        return str(key_res.json()["key"])


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def hub(api_server: str, prompts_api_key: str) -> Iterator[Any]:
    """One shared `AcruxCore` client for this file's tests, pointed at the live
    subprocess server with a real API key. Shared (not per-test) for the same
    reason `conftest.py`'s own `hub` fixture is — every test here can safely
    reuse one team/user.
    """
    client = AcruxCore(api_key=prompts_api_key, base_url=api_server, max_retries=0)
    try:
        yield client
    finally:
        await client.gateway.aclose()


async def test_full_prompt_version_lifecycle(
    hub: AcruxCore, api_server: str, prompts_api_key: str
) -> None:
    """create -> get -> update (incl. the omit-vs-null `description` sentinel)
    -> commit v1 (aliases present) -> commit v2 (aliases absent) ->
    list/get versions -> diff -> promote_alias -> export_version ->
    import_prompt -> traces_for_version -> list -> delete -> 404 on re-get.
    """
    created = await hub.prompts.create(
        f"lifecycle-prompt-{uuid.uuid4()}", description="Initial description"
    )
    assert isinstance(created.id, str) and created.id
    assert created.description == "Initial description"

    fetched = await hub.prompts.get(created.id)
    assert fetched == created

    updated = await hub.prompts.update(created.id, description="Updated description")
    assert updated.description == "Updated description"
    assert updated.name == created.name

    # update()'s `description` sentinel: omitting the keyword leaves the stored
    # value untouched (not cleared)...
    renamed_only = await hub.prompts.update(created.id, name=created.name)
    assert renamed_only.description == "Updated description"

    # ...while an explicit `description=None` clears it.
    cleared = await hub.prompts.update(created.id, description=None)
    assert cleared.description is None
    assert cleared.name == created.name

    # commit_version v1 — aliases present (first version mints both production + staging)
    v1 = await hub.prompts.commit_version(
        created.id,
        [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "Hello, {{ name }}!"},
        ],
    )
    assert v1.version_number == 1
    assert v1.prompt_id == created.id
    assert v1.variables == ["name"]
    assert v1.aliases is not None
    assert sorted(a.alias for a in v1.aliases) == ["production", "staging"]
    assert all(a.version_number == 1 for a in v1.aliases)

    # commit_version v2 — aliases absent (committing never moves an alias by itself)
    v2 = await hub.prompts.commit_version(
        created.id, [{"role": "user", "content": "Hi there, {{ name }}!"}]
    )
    assert v2.version_number == 2
    assert v2.aliases is None

    # list_versions — newest first, no `messages`/`prompt_id` on list items
    versions_page = await hub.prompts.list_versions(created.id)
    assert versions_page.total == 2
    assert [v.version_number for v in versions_page.data] == [2, 1]
    # `versions_page.data[0]` is a dataclass, so `hasattr(..., "messages")` would
    # always be True/False based on the dataclass's fixed field set regardless of
    # what the API actually returned — it can never catch drift. Go around the
    # SDK's parsing and check the raw wire response instead, the way the TS suite's
    # `expect(...).not.toHaveProperty(...)` inspects real parsed JSON.
    async with httpx.AsyncClient(base_url=api_server, timeout=30.0) as raw_client:
        raw_res = await raw_client.get(
            f"/prompts/{created.id}/versions",
            headers={"Authorization": f"Bearer {prompts_api_key}"},
        )
        assert raw_res.status_code == 200
        raw_first_item = raw_res.json()["data"][0]
        assert "messages" not in raw_first_item
        assert "promptId" not in raw_first_item
        assert raw_first_item["versionNumber"] == 2

    # get_version — full content, never `aliases`
    got_v1 = await hub.prompts.get_version(created.id, 1)
    assert got_v1.messages == v1.messages
    assert got_v1.aliases is None

    # diff(1, 2)
    diff_result = await hub.prompts.diff(created.id, 1, 2)
    assert diff_result.from_version == 1
    assert diff_result.to_version == 2
    assert isinstance(diff_result.diff, str)
    assert len(diff_result.diff) > 0

    # promote_alias — move `production` to v2
    promoted = await hub.prompts.promote_alias(created.id, "production", 2)
    assert promoted.alias == "production"
    assert promoted.version_number == 2

    # export_version
    exported = await hub.prompts.export_version(created.id, 1)
    assert exported.schema_version == 1
    assert exported.prompt.name == created.name
    assert exported.version.version_number == 1
    assert exported.version.messages == v1.messages

    # import_prompt — the just-exported version, as a brand new prompt
    imported = await hub.prompts.import_prompt(exported.to_import_body())
    assert imported.prompt.id != created.id
    assert imported.version.version_number == 1

    # traces_for_version — no traces have been reported against this version yet
    traces = await hub.prompts.traces_for_version(created.id, 1)
    assert traces.data == []
    assert traces.total == 0

    # list — both the created prompt and the imported copy appear
    list_page = await hub.prompts.list()
    ids = [p.id for p in list_page.data]
    assert created.id in ids
    assert imported.prompt.id in ids

    # delete -> get on the deleted id throws API_ERROR / 404. Also deletes the
    # imported copy, so this suite leaves no litter in the shared test database.
    await hub.prompts.delete(created.id)
    await hub.prompts.delete(imported.prompt.id)

    with pytest.raises(AcruxCoreError) as exc_info:
        await hub.prompts.get(created.id)
    assert exc_info.value.code == API_ERROR
    assert exc_info.value.status_code == 404


async def test_error_paths(hub: AcruxCore) -> None:
    """An empty `name` on create surfaces VALIDATION_ERROR; a random UUID on
    get surfaces a 404 — both as `AcruxCoreError(code=API_ERROR)`.
    """
    with pytest.raises(AcruxCoreError) as create_exc:
        await hub.prompts.create("")
    assert create_exc.value.code == API_ERROR
    assert create_exc.value.status_code == 400
    assert create_exc.value.body["error"]["code"] == "VALIDATION_ERROR"

    with pytest.raises(AcruxCoreError) as get_exc:
        await hub.prompts.get("00000000-0000-0000-0000-000000000000")
    assert get_exc.value.code == API_ERROR
    assert get_exc.value.status_code == 404
