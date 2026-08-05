/**
 * Version a prompt -- Node.
 *
 * Walks the full prompt-version lifecycle through `hub.prompts` end to end:
 *
 *   1. create() a prompt.
 *   2. commitVersion() twice (v1, then v2 with a bound `model`).
 *   3. diff() v1 against v2.
 *   4. promoteAlias() to point `production` at v2.
 *   5. exportVersion() v2 to a portable JSON document.
 *   6. importPrompt() that document back in as a brand-new copy.
 *   7. tracesForVersion() on v2 -- expect zero, since nothing has called it.
 *   8. delete() both the original prompt and the imported copy (cleanup).
 *
 * Also lists prompts before and after so a reader can see the run leaves no
 * litter: the total count is identical at the start and the end.
 *
 * Requires:
 *   npm install @acruxcoreai/sdk
 *
 * Reads ACRUXCORE_API_KEY / ACRUXCORE_BASE_URL from the environment. `model` is
 * optional on commitVersion(), so v2's bound model comes from ACRUXCORE_MODEL --
 * left unset, v2 is committed with no bound model at all rather than a hardcoded
 * one, since `model` must be registered as a gateway model for your team and a
 * hardcoded name would 400 for any reader who hasn't registered that exact model.
 *
 * Run:
 *   node run_lifecycle.mjs
 */
import AcruxCore from '@acruxcoreai/sdk';

const MODEL = process.env.ACRUXCORE_MODEL;

function section(number, title) {
  console.log(`\n${'='.repeat(64)}\n${number}. ${title}\n${'='.repeat(64)}`);
}

async function main() {
  const hub = new AcruxCore();
  const promptName = `lifecycle-demo-${Date.now()}`;

  section(0, 'Count prompts before the run');
  const before = await hub.prompts.list();
  console.log('prompt count (before):', before.total);

  // Tracked so the finally block can clean up whatever actually got created,
  // even if a later step throws -- the imported copy in particular doesn't
  // exist until the import step succeeds, so its id stays null until then
  // and is only deleted if it was ever assigned.
  let promptId = null;
  let importedPromptId = null;
  try {
    // 1. create() -------------------------------------------------------------
    section(1, 'Create a prompt');
    const prompt = await hub.prompts.create({
      name: promptName,
      description: 'Created by the version-a-prompt lifecycle script.',
    });
    promptId = prompt.id;
    console.log('prompt id    :', prompt.id);
    console.log('prompt name  :', prompt.name);

    // 2. commitVersion() x2 -----------------------------------------------------
    section(2, 'Commit version 1');
    const v1 = await hub.prompts.commitVersion(prompt.id, {
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: 'Say hello to {{name}}.' },
      ],
    });
    console.log('version number:', v1.versionNumber);
    console.log('version id    :', v1.id);
    console.log('aliases minted:', v1.aliases?.map((a) => a.alias));

    section(3, 'Commit version 2 (with a bound model)');
    const v2 = await hub.prompts.commitVersion(prompt.id, {
      messages: [
        { role: 'system', content: 'You are a concise, friendly assistant.' },
        { role: 'user', content: 'Say a warm hello to {{name}}.' },
      ],
      ...(MODEL ? { model: MODEL } : {}),
    });
    console.log('version number:', v2.versionNumber);
    console.log('version id    :', v2.id);
    console.log('bound model   :', MODEL ? v2.model : '(none -- set ACRUXCORE_MODEL to bind one)');

    // 3. diff() -----------------------------------------------------------------
    section(4, 'Diff v1 against v2');
    const diffResult = await hub.prompts.diff(prompt.id, v1.versionNumber, v2.versionNumber);
    console.log('diff (from -> to):', diffResult.fromVersion, '->', diffResult.toVersion);
    console.log('diff text:\n' + diffResult.diff);

    // 4. promoteAlias() -----------------------------------------------------------
    section(5, 'Promote production to v2');
    const alias = await hub.prompts.promoteAlias(prompt.id, 'production', v2.versionNumber);
    console.log('alias         :', alias.alias);
    console.log('now points at :', 'v' + alias.versionNumber);

    // 5. exportVersion() ----------------------------------------------------------
    section(6, 'Export v2');
    const exported = await hub.prompts.exportVersion(prompt.id, v2.versionNumber);
    console.log('schemaVersion :', exported.schemaVersion);
    console.log('exported name :', exported.prompt.name);

    // 6. importPrompt() -----------------------------------------------------------
    section(7, 'Import the export as a new prompt');
    const imported = await hub.prompts.importPrompt(exported);
    importedPromptId = imported.prompt.id;
    console.log('imported prompt id  :', imported.prompt.id);
    console.log('imported prompt name:', imported.prompt.name);
    console.log('different id?       :', imported.prompt.id !== prompt.id);
    if (imported.prompt.id === prompt.id) {
      throw new Error("importPrompt() returned the original prompt's id instead of a new copy");
    }

    // 7. tracesForVersion() -------------------------------------------------------
    section(8, 'Traces for v2 (expect zero -- nothing has called it)');
    const traces = await hub.prompts.tracesForVersion(prompt.id, v2.versionNumber);
    console.log('trace total   :', traces.total);
    console.log('trace data len:', traces.data.length);
  } finally {
    // 8. cleanup ------------------------------------------------------------------
    // Runs whether the try block succeeded or threw, so a mid-run failure
    // (network blip, validation error, permission issue) still deletes
    // whatever was actually created instead of leaving litter.
    section(9, 'Cleanup: delete both prompts');
    if (importedPromptId !== null) {
      await hub.prompts.delete(importedPromptId);
      console.log('deleted imported prompt:', importedPromptId);
    }
    if (promptId !== null) {
      await hub.prompts.delete(promptId);
      console.log('deleted original prompt:', promptId);
    }
  }

  section(10, 'Count prompts after the run');
  const after = await hub.prompts.list();
  console.log('prompt count (after) :', after.total);
  console.log('no litter left       :', after.total === before.total);

  if (after.total !== before.total) {
    throw new Error(
      `Litter left behind: prompt count went from ${before.total} to ${after.total}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
