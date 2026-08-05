"""
Version a prompt -- Python.

Walks the full prompt-version lifecycle through ``client.prompts`` end to end:

  1. create() a prompt.
  2. commit_version() twice (v1, then v2 with a bound ``model``).
  3. diff() v1 against v2.
  4. promote_alias() to point ``production`` at v2.
  5. export_version() v2 to a portable JSON document.
  6. import_prompt() that document back in as a brand-new copy.
  7. traces_for_version() on v2 -- expect zero, since nothing has called it.
  8. delete() both the original prompt and the imported copy (cleanup).

Also lists prompts before and after so a reader can see the run leaves no
litter: the total count is identical at the start and the end.

Requires:
  pip install acruxcore

Reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL from the environment. ``model`` is
optional on commit_version(), so v2's bound model comes from ACRUXCORE_MODEL --
left unset, v2 is committed with no bound model at all rather than a hardcoded
one, since ``model`` must be registered as a gateway model for your team and a
hardcoded name would 400 for any reader who hasn't registered that exact model.

Run:
  python run_lifecycle.py
"""
import asyncio
import os
import time

from acruxcore import AcruxCore

MODEL = os.environ.get("ACRUXCORE_MODEL")


def section(number, title):
    print(f"\n{'=' * 64}\n{number}. {title}\n{'=' * 64}")


async def main():
    async with AcruxCore() as hub:
        prompt_name = f"lifecycle-demo-{int(time.time() * 1000)}"

        section(0, "Count prompts before the run")
        before = await hub.prompts.list()
        print(f"prompt count (before): {before.total}")

        # Tracked so the finally block can clean up whatever actually got
        # created, even if a later step throws -- the imported copy in
        # particular doesn't exist until the import step succeeds, so its id
        # stays None until then and is only deleted if it was ever assigned.
        prompt_id = None
        imported_prompt_id = None
        try:
            # 1. create() ---------------------------------------------------------
            section(1, "Create a prompt")
            prompt = await hub.prompts.create(
                prompt_name, description="Created by the version-a-prompt lifecycle script."
            )
            prompt_id = prompt.id
            print(f"prompt id    : {prompt.id}")
            print(f"prompt name  : {prompt.name}")

            # 2. commit_version() x2 ------------------------------------------------
            section(2, "Commit version 1")
            v1 = await hub.prompts.commit_version(
                prompt.id,
                [
                    {"role": "system", "content": "You are a concise assistant."},
                    {"role": "user", "content": "Say hello to {{name}}."},
                ],
            )
            print(f"version number: {v1.version_number}")
            print(f"version id    : {v1.id}")
            print(f"aliases minted: {[a.alias for a in (v1.aliases or [])]}")

            section(3, "Commit version 2 (with a bound model)")
            v2 = await hub.prompts.commit_version(
                prompt.id,
                [
                    {"role": "system", "content": "You are a concise, friendly assistant."},
                    {"role": "user", "content": "Say a warm hello to {{name}}."},
                ],
                **({"model": MODEL} if MODEL else {}),
            )
            print(f"version number: {v2.version_number}")
            print(f"version id    : {v2.id}")
            bound_model = v2.model if MODEL else "(none -- set ACRUXCORE_MODEL to bind one)"
            print(f"bound model   : {bound_model}")

            # 3. diff() -------------------------------------------------------------
            section(4, "Diff v1 against v2")
            diff_result = await hub.prompts.diff(prompt.id, v1.version_number, v2.version_number)
            print(f"diff (from -> to): {diff_result.from_version} -> {diff_result.to_version}")
            print("diff text:\n" + diff_result.diff)

            # 4. promote_alias() ------------------------------------------------------
            section(5, "Promote production to v2")
            alias = await hub.prompts.promote_alias(prompt.id, "production", v2.version_number)
            print(f"alias         : {alias.alias}")
            print(f"now points at : v{alias.version_number}")

            # 5. export_version() -------------------------------------------------------
            section(6, "Export v2")
            exported = await hub.prompts.export_version(prompt.id, v2.version_number)
            print(f"schema_version: {exported.schema_version}")
            print(f"exported name : {exported.prompt.name}")

            # 6. import_prompt() ----------------------------------------------------------
            section(7, "Import the export as a new prompt")
            imported = await hub.prompts.import_prompt(exported.to_import_body())
            imported_prompt_id = imported.prompt.id
            print(f"imported prompt id  : {imported.prompt.id}")
            print(f"imported prompt name: {imported.prompt.name}")
            print(f"different id?       : {imported.prompt.id != prompt.id}")
            if imported.prompt.id == prompt.id:
                raise RuntimeError(
                    "import_prompt() returned the original prompt's id instead of a new copy"
                )

            # 7. traces_for_version() ------------------------------------------------------
            section(8, "Traces for v2 (expect zero -- nothing has called it)")
            traces = await hub.prompts.traces_for_version(prompt.id, v2.version_number)
            print(f"trace total   : {traces.total}")
            print(f"trace data len: {len(traces.data)}")
        finally:
            # 8. cleanup ----------------------------------------------------------------
            # Runs whether the try block succeeded or raised, so a mid-run
            # failure (network blip, validation error, permission issue) still
            # deletes whatever was actually created instead of leaving litter.
            section(9, "Cleanup: delete both prompts")
            if imported_prompt_id is not None:
                await hub.prompts.delete(imported_prompt_id)
                print(f"deleted imported prompt: {imported_prompt_id}")
            if prompt_id is not None:
                await hub.prompts.delete(prompt_id)
                print(f"deleted original prompt: {prompt_id}")

        section(10, "Count prompts after the run")
        after = await hub.prompts.list()
        print(f"prompt count (after) : {after.total}")
        print(f"no litter left       : {after.total == before.total}")

        if after.total != before.total:
            raise RuntimeError(
                f"Litter left behind: prompt count went from {before.total} to {after.total}"
            )


if __name__ == "__main__":
    asyncio.run(main())
