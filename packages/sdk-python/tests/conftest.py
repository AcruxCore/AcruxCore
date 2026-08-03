"""Shared fixtures for the live-API integration suite (``test_byo_integration.py``).

Unlike the rest of this package's tests (all mocked, no network — see
``test_unit.py``'s and ``test_tools_api.py``'s module docstrings), this file boots
a REAL `apps/api` server as a subprocess and drives it with real HTTP calls,
mirroring the Node SDK's `packages/sdk/test/integration/byo.integration.test.ts`
(which boots the same Express app in-process — Python can't do that across a
language boundary, so a subprocess + real network calls is the equivalent here).

Nothing in this file is imported by the rest of the package; it exists purely to
give ``test_byo_integration.py`` a live server plus a fully self-provisioned team
(user, API key, `greeting` prompt, gateway connection + model) to run against.

CONCURRENCY WARNING: this suite is not wired into `turbo.json` or any CI
workflow. Its subprocess `apps/api` server points at the SAME `TEST_DATABASE_URL`
that `npm test` (apps/api's own Jest suite, run in-process via supertest) and
`packages/sdk`'s own integration suite use. Do NOT run this suite at the same
time as `npm test` or another live integration suite against that database —
none of these suites coordinate locking or truncation with each other, so
concurrent runs can race (e.g. one suite's `TRUNCATE ... CASCADE` deleting rows
another is mid-read on). Each run here is self-contained (a fresh UUID-based
signup, and no truncation of its own — truncating is exactly the hazard just
described for anything running alongside), so sequential re-runs are safe — only
*concurrent* runs against the same database are the hazard. It is a real one: a
`packages/sdk` integration run truncating `users`/`api_keys` mid-run makes every
call here fail with a bare 401 that looks nothing like a truncation. To run
alongside another suite, point this run at its own database instead —
`createdb <name>`, `DATABASE_URL=… DIRECT_URL=… npx prisma migrate deploy` from
`apps/api`, then `TEST_DATABASE_URL=…/<name> pytest tests/test_byo_integration.py`
(the subprocess server is handed that variable, see `api_server`).

CLEANUP: because it does not truncate, this suite explicitly deletes the one row
that must never accumulate — the gateway connection it registers, which stores an
ENCRYPTED COPY OF THE REAL PROVIDER KEY. Without that teardown every run would
leave one more stored credential behind in the shared test database. See
`provisioned_env`'s teardown.

`.env` loading is intentionally NOT eager at module import time: pytest imports
this `conftest.py` whenever it collects anything under this `tests/` directory,
including when only `test_unit.py`/`test_tooling.py`/`test_tools_api.py` are
being run — none of which need or expect the repo-root `.env` loaded into their
process. `_load_root_env()` is therefore only called lazily, from inside the
`api_server` fixture body, so it only ever fires when a test in
`test_byo_integration.py` actually requests it.
"""

from __future__ import annotations

import os
import socket
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Iterator

import httpx
import pytest
import pytest_asyncio

from acruxcore import AcruxCore

# Password used for every test account created by this suite. Never leaves this process.
_TEST_PASSWORD = "test-password-not-a-real-one-1234"

# How long to wait for the subprocess `apps/api` server to answer its first request.
_BOOT_TIMEOUT_S = 15.0


def _repo_root() -> Path:
    """Walk up from this file until the monorepo root (marked by `turbo.json`) is found.

    Mirrors `apps/api/src/shared/env/load-root-env.ts`'s own upward walk, so this
    file finds the same single repo-root `.env` that the Node SDK's
    `jest.setup.ts` loads explicitly (see its header comment) and that the
    `apps/api` subprocess launched below loads itself on boot.
    """
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "turbo.json").exists():
            return parent
    raise RuntimeError("could not locate monorepo root (no turbo.json found above conftest.py)")


def _load_root_env() -> None:
    """Load the repo-root `.env` into this process, without clobbering real env vars.

    No `python-dotenv` dependency existed in this package before this file — every
    other test here is mocked and needs no environment at all (see `e2e_live.py`,
    which just reads `os.environ` and assumes the caller already exported
    everything). This suite is the first to need the same repo-root `.env` the
    Node SDK's `jest.setup.ts` loads, so `python-dotenv` is added as a dev
    dependency (see `pyproject.toml`) purely for this purpose.
    """
    try:
        from dotenv import load_dotenv
    except ImportError as err:  # pragma: no cover - dev dependency should always be installed
        raise RuntimeError(
            "python-dotenv is required to run the live integration suite — "
            "install the package's dev dependencies (`pip install -e '.[dev]'`)."
        ) from err

    # override=False (dotenv's default): a variable already present in the real
    # environment always wins, same contract as the Node side's `dotenv.config()`.
    load_dotenv(dotenv_path=_repo_root() / ".env", override=False)


def _free_port() -> int:
    """Ask the OS for an unused TCP port, the same way Node's `server.listen(0)` does."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="session")
def api_server() -> Iterator[str]:
    """Boots a real `apps/api` server as a subprocess against the shared test DB.

    Equivalent of the Node suite's in-process `createServer(app)` — Python has no
    way to boot the (TypeScript) Express app in-process, so this launches the real
    `npx tsx server.ts` entry point as a child process instead, pointed at
    `TEST_DATABASE_URL` via `NODE_ENV=test` (see `apps/api/src/shared/db/client.ts`),
    and polls a real endpoint until it answers.

    :yields: The server's `/api/v1`-prefixed base URL.
    :raises RuntimeError: If the server does not answer within `_BOOT_TIMEOUT_S`
        seconds — the subprocess's captured stdout/stderr is included in the
        error so a real startup failure is never silent.
    """
    # Lazy on purpose — see this module's docstring: loading here (rather than
    # at import time) keeps this file inert for every test file except
    # `test_byo_integration.py`, whose tests are the only ones that request
    # this fixture.
    _load_root_env()

    root = _repo_root()
    api_dir = root / "apps" / "api"
    port = _free_port()
    base_url = f"http://localhost:{port}/api/v1"

    env = {
        **os.environ,
        "NODE_ENV": "test",
        "PORT": str(port),
        # Mirrors `apps/api/src/test-utils/jest-env.ts`: the repo-root `.env` sets
        # AUTH_REQUIRE_EMAIL_VERIFICATION to an empty string, which resolves to
        # "required" (derived from EMAIL_TRANSPORT=smtp) unless explicitly forced
        # off — without this, sign-up never returns a usable session.
        "AUTH_REQUIRE_EMAIL_VERIFICATION": "false",
    }
    if os.environ.get("TEST_DATABASE_URL"):
        env["TEST_DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]

    # Captures the subprocess's stdout/stderr for the (rare) case of a boot
    # failure. Always deleted before this fixture returns — on every exit path,
    # not just the happy one — so repeated runs never accumulate files here.
    log_path = Path(
        os.environ.get("TMPDIR", "/tmp")
    ) / f"acruxcore-byo-integration-api-{port}.log"
    log_file = open(log_path, "w")

    def _log_contents() -> str:
        log_file.flush()
        try:
            return log_path.read_text()
        except FileNotFoundError:
            return ""

    proc = subprocess.Popen(
        ["npx", "tsx", "server.ts"],
        cwd=str(api_dir),
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )

    try:
        deadline = time.time() + _BOOT_TIMEOUT_S
        last_error: Exception | None = None
        up = False
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(
                    f"apps/api subprocess exited early (code {proc.returncode}) — "
                    f"captured output:\n{_log_contents()}"
                )
            try:
                # No auth header on purpose: any prompt-y response (401
                # unauthenticated, not a connection error) proves the HTTP
                # server itself is listening.
                resp = httpx.get(f"{base_url}/prompts", timeout=1.0)
                if resp.status_code == 401:
                    up = True
                    break
            except httpx.TransportError as err:
                last_error = err
            time.sleep(0.2)

        if not up:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            raise RuntimeError(
                f"apps/api server did not answer on {base_url} within "
                f"{_BOOT_TIMEOUT_S}s (last error: {last_error}) — captured "
                f"output:\n{_log_contents()}"
            )

        try:
            yield base_url
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
    finally:
        log_file.close()
        log_path.unlink(missing_ok=True)


def _session_cookie(response: httpx.Response) -> str:
    """Extracts the `name=value` session cookie pair from a sign-up response.

    Mirrors the Node test-utils' `sessionCookie` helper — only the pair is kept,
    since the rest of a `Set-Cookie` header is browser-only instruction.
    """
    raw = response.headers.get("set-cookie")
    if not raw or "session_token" not in raw:
        raise RuntimeError(
            f"No session cookie in sign-up response (status {response.status_code}): "
            f"{response.text}"
        )
    return raw.split(";")[0]


#: Name of the catalog tool registered with a server-side (`http`) executor — the
#: `tool_refs` + `http` route the BYO trace-ordering test drives. Module-level so
#: the test file can pass it as a `tool_refs` name without hardcoding a duplicate.
HTTP_TOOL_NAME = "probe_endpoint"


@pytest.fixture(scope="session")
def provisioned_env(api_server: str) -> Iterator[Dict[str, Any]]:
    """Self-provisions a fresh team on the live server: user, API key, `greeting`
    prompt (fixture for the trace read-back tests), a catalog tool with a
    server-side `http` executor, and a real gateway connection + model bound to
    `ACRUXCORE_TEST_MODEL` via OpenRouter.

    Mirrors the Node suite's `beforeAll` exactly (same endpoints, same payload
    shapes, same reasoning for registering a gateway connection using the SAME
    OpenRouter credential and model id the BYO arm calls directly — see that
    file's header comment) — just over real HTTP instead of supertest-in-process.

    On teardown it deletes the registered model and then the gateway connection
    (that order is required: the credential FK is `onDelete: Restrict`, so a
    connection with a model still bound to it answers 409 `CREDENTIAL_IN_USE`).
    That connection row holds an encrypted copy of the real provider key, and this
    suite deliberately does not truncate, so without this cleanup every run would
    leave one more stored credential behind — see this module's docstring.

    :param api_server: The running server's base URL. Depending on it guarantees
        `_load_root_env()` has already run (it's the first thing that fixture
        does), so the provider env vars read below are populated.
    :yields: `{"base_url", "api_key", "prompt_version_id", "http_tool_name"}`.
    """
    provider_base_url = os.environ.get("ACRUXCORE_TEST_PROVIDER_BASE_URL", "")
    provider_api_key = os.environ.get("ACRUXCORE_TEST_PROVIDER_API_KEY", "")
    test_model = os.environ.get("ACRUXCORE_TEST_MODEL") or "gpt-4o-mini"

    if not provider_base_url or not provider_api_key:
        pytest.skip(
            "ACRUXCORE_TEST_PROVIDER_BASE_URL / ACRUXCORE_TEST_PROVIDER_API_KEY not "
            "set — cannot provision a live gateway connection.",
        )

    with httpx.Client(base_url=api_server, timeout=30.0) as c:
        email = f"test-user-{uuid.uuid4()}@example.com"
        signup = c.post(
            "/auth/sign-up/email",
            json={"email": email, "password": _TEST_PASSWORD, "name": "Test User"},
        )
        if signup.status_code != 200:
            raise RuntimeError(f"sign-up failed ({signup.status_code}): {signup.text}")
        cookie = _session_cookie(signup)
        headers = {"Cookie": cookie}

        key_res = c.post("/api-keys", json={"name": "test key"}, headers=headers)
        if key_res.status_code != 201:
            raise RuntimeError(f"api-key creation failed ({key_res.status_code}): {key_res.text}")
        api_key = key_res.json()["key"]

        # Fixture for the trace read-back suite's `hub.render_prompt("greeting", ...)`.
        prompt_res = c.post("/prompts", json={"name": "greeting"}, headers=headers)
        if prompt_res.status_code != 201:
            raise RuntimeError(f"prompt creation failed ({prompt_res.status_code}): {prompt_res.text}")
        prompt_id = prompt_res.json()["id"]

        version_res = c.post(
            f"/prompts/{prompt_id}/versions",
            json={"messages": [{"role": "user", "content": "Say hello to {{ name }}."}]},
            headers=headers,
        )
        if version_res.status_code != 201:
            raise RuntimeError(f"prompt version failed ({version_res.status_code}): {version_res.text}")
        prompt_version_id = version_res.json()["id"]

        promote_res = c.post(
            f"/prompts/{prompt_id}/aliases/production/promote",
            json={"version_number": 1},
            headers=headers,
        )
        if promote_res.status_code != 200:
            raise RuntimeError(f"promote failed ({promote_res.status_code}): {promote_res.text}")

        # Real gateway connection + model backed by the SAME OpenRouter credential
        # the BYO arm calls directly, under the SAME public name every test passes
        # as `model` (TEST_MODEL) — so `hub.chat(model, messages)` with no
        # `provider=` routes through the gateway to this connection instead of
        # failing with MODEL_NOT_REGISTERED. Pricing fields are omitted
        # deliberately, same reasoning as the Node suite: OpenRouter's
        # `openai/gpt-4o-mini` id isn't in the static pricing registry, so it
        # resolves to null rather than failing validation.
        conn_res = c.post(
            "/gateway/connections",
            json={
                "provider": "openai_compatible",
                "label": "byo-comparison test (python)",
                "apiKey": provider_api_key,
                "config": {"base_url": provider_base_url},
            },
            headers=headers,
        )
        if conn_res.status_code != 201:
            raise RuntimeError(f"connection creation failed ({conn_res.status_code}): {conn_res.text}")
        connection_id = conn_res.json()["id"]

        model_res = c.post(
            "/gateway/models",
            json={
                "publicName": test_model,
                "upstreamModel": test_model,
                "credentialId": connection_id,
            },
            headers=headers,
        )
        if model_res.status_code != 201:
            raise RuntimeError(f"model registration failed ({model_res.status_code}): {model_res.text}")
        model_id = model_res.json()["id"]

        # A catalog tool whose executor runs SERVER-SIDE (`http`), so a `tool_refs`
        # entry for it resolves to the `http` route and the platform — not the SDK —
        # executes it and writes its `tool` span mid-loop. That is the only route that
        # can catch the trace-ordering bug the BYO loop had (a tool span landing at the
        # root of a `tool:<name>`-named trace instead of nested under the round's `llm`
        # span), so this suite has to have one.
        #
        # The URL deliberately points at the PROVIDER's own base URL rather than a
        # local HTTP server: `apps/api`'s SSRF guard refuses every loopback/private
        # address and has no env-var or NODE_ENV bypass — its only seam is the
        # in-process `allowLoopbackForTests()`, which a subprocess server cannot be
        # asked to call. `GET https://openrouter.ai/api/v1/key` is unauthenticated,
        # answers a small JSON 401 with no redirect (a non-2xx is NOT an executor
        # failure — only a redirect/timeout/oversize body is), and this suite already
        # requires that host to be reachable. The responseTransform makes the tool's
        # result independent of the body, so nothing here depends on OpenRouter's
        # error shape.
        tool_res = c.post(
            "/tools/sync",
            json={
                "name": HTTP_TOOL_NAME,
                "description": "Probe the demo endpoint and return the HTTP status it answered with.",
                "parametersSchema": {"type": "object", "properties": {}},
                "executor": {
                    "type": "http",
                    "url": f"{provider_base_url.rstrip('/')}/key",
                    "method": "GET",
                    "responseTransform": "function transform(input) { return { status: input.status }; }",
                },
                "alias": "production",
                "source": "api",
            },
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if tool_res.status_code != 200:
            raise RuntimeError(f"http tool sync failed ({tool_res.status_code}): {tool_res.text}")

    try:
        yield {
            "base_url": api_server,
            "api_key": api_key,
            "prompt_version_id": prompt_version_id,
            "http_tool_name": HTTP_TOOL_NAME,
        }
    finally:
        # Best-effort: a cleanup failure must not turn a green run red, but it must
        # not be silent either — the whole point is that the stored credential is gone.
        with httpx.Client(base_url=api_server, timeout=30.0) as c:
            for label, path in (
                ("gateway model", f"/gateway/models/{model_id}"),
                ("gateway connection", f"/gateway/connections/{connection_id}"),
            ):
                try:
                    res = c.delete(path, headers=headers)
                    if res.status_code >= 400:
                        print(
                            f"[conftest] WARNING: deleting the {label} left a row behind "
                            f"({res.status_code}): {res.text}"
                        )
                except httpx.HTTPError as err:  # pragma: no cover - network hiccup at teardown
                    print(f"[conftest] WARNING: deleting the {label} failed: {err}")


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def hub(provisioned_env: Dict[str, Any]) -> Any:
    """One shared `AcruxCore` client for the whole live-integration suite.

    Deliberately shared across every test in `test_byo_integration.py` (all of
    which run under `pytestmark = pytest.mark.asyncio(loop_scope="session")`, so
    they share one event loop and can safely reuse one `httpx.AsyncClient`),
    exactly like the Node suite's single `hub` built once in `beforeAll` — see
    that file's header comment for why (same team/user/model for every
    comparison). Also matches Node's choice to keep the SDK's default
    `max_retries=1` rather than 0, since the 429-retry test needs a real retry to
    happen.
    """
    client = AcruxCore(api_key=provisioned_env["api_key"], base_url=provisioned_env["base_url"])
    try:
        yield client
    finally:
        await client.aclose()
