import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTools } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { Button, Field, Input, Select, Textarea } from '@/ui';
import { SavePromptDialog } from './SavePromptDialog';
import { SaveVersionDialog } from './SaveVersionDialog';
import { Telemetry } from './Telemetry';
import { ToolPicker } from './ToolPicker';
import { ToolCallCard } from './ToolCallCard';
import { MessageListEditor } from './playground/MessageListEditor';
import { usePlaygroundTelemetry } from './playground/usePlaygroundTelemetry';
import { usePromptSelection } from './playground/usePromptSelection';
import { useToolLoop } from './playground/useToolLoop';
import { useSingleShotSend } from './playground/useSingleShotSend';
import { useSaveMenu } from './playground/useSaveMenu';

/**
 * The Playground — the signature surface. An OpenAI-compatible chat console
 * that sends a request through the gateway and surfaces the `x-gateway-*`
 * telemetry live, so the routing/pricing/caching the gateway performs is
 * visible. Supports raw messages or a stored-prompt reference (G8 lineage),
 * and token-by-token streaming (G7). Edits can be saved back as a new
 * version of the loaded prompt or as a brand-new prompt (F2).
 */
export function PlaygroundPage() {
  const { canWrite } = useAuth();
  const prompt = usePromptSelection();
  const telemetry = usePlaygroundTelemetry();
  const toolLoop = useToolLoop(telemetry);
  const singleShot = useSingleShotSend(telemetry, prompt.buildBody);

  // ── Tool calling (TC5) ─────────────────────────────────────────────────
  // Tools the user has attached to this request via the chip row below. An
  // empty array means "no tools" — `send()` then takes the original
  // single-shot path unchanged (see the Global Constraint in the TC5 plan).
  const { data: toolsPage } = useTools();
  const [attachedToolIds, setAttachedToolIds] = useState<string[]>([]);

  /**
   * Entry point wired to the Send/Stream button. Routes to the tool-calling
   * loop when one or more tools are attached (TC5); otherwise runs the
   * original single-shot path unchanged — this is the hard regression-safety
   * requirement from the TC5 plan's Global Constraints.
   */
  async function send() {
    toolLoop.setActiveCalls([]);
    if (attachedToolIds.length > 0) {
      const attached = (toolsPage?.data ?? []).filter((t) => attachedToolIds.includes(t.id));
      await toolLoop.run(prompt.buildBody, attached);
      return;
    }
    await singleShot.send();
  }

  // Messages currently on screen, from whichever editor is active — the
  // source of truth for the Save ▾ menu, regardless of mode.
  const messagesToSave = (prompt.mode === 'messages' ? prompt.messages : prompt.promptMessages).filter(
    (m) => m.content.trim() !== '',
  );
  const canSave = canWrite && messagesToSave.length > 0;

  const saveMenu = useSaveMenu({
    saveTargetPromptId: prompt.saveTargetPromptId,
    saveTargetPromptName: prompt.saveTargetPromptName,
    setSaveTargetPromptId: prompt.setSaveTargetPromptId,
    setSaveTargetPromptName: prompt.setSaveTargetPromptName,
    messagesToSave,
    model: prompt.model,
  });

  const running = telemetry.state === 'running';

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Playground</h1>
        <p className="mt-1 text-[13px] text-muted">
          Send a completion through the gateway and watch what it does — routing, cost, cache, and
          latency, live.
        </p>
      </header>

      {/* Request builder */}
      <section className="rounded-xl border border-line bg-surface">
        <div className="flex items-center gap-1 border-b border-line-soft px-4 pt-3">
          {(['messages', 'prompt'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => prompt.selectMode(m)}
              className={[
                '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-[color]',
                prompt.mode === m ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
              ].join(' ')}
            >
              {m === 'messages' ? 'Messages' : 'Stored prompt'}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-4 p-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
            <Field label="Model" htmlFor="pg-model">
              {prompt.models && prompt.models.length > 0 ? (
                <Select
                  id="pg-model"
                  value={prompt.model}
                  onChange={(e) => prompt.setModel(e.target.value)}
                  className="font-mono"
                >
                  {prompt.models.map((m) => (
                    <option key={m.id} value={m.publicName}>
                      {m.publicName}
                    </option>
                  ))}
                </Select>
              ) : (
                <div className="flex h-9 items-center text-[13px] text-muted">
                  No models —{' '}
                  <Link to="/gateway/models" className="ml-1 text-accent hover:underline">
                    register one
                  </Link>
                </div>
              )}
            </Field>
            <Field label="Temp" htmlFor="pg-temp">
              <Input
                id="pg-temp"
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={prompt.temperature}
                onChange={(e) => prompt.setTemperature(e.target.value)}
                className="w-20"
              />
            </Field>
            <Field label="Max tokens" htmlFor="pg-max">
              <Input
                id="pg-max"
                type="number"
                min="1"
                value={prompt.maxTokens}
                onChange={(e) => prompt.setMaxTokens(e.target.value)}
                className="w-24"
              />
            </Field>
            <label
              className="flex h-9 items-center gap-2 text-[13px] text-muted"
              title={
                attachedToolIds.length > 0
                  ? 'Streaming is not supported while tools are attached — the tool-calling loop always sends non-streamed.'
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={singleShot.stream}
                disabled={attachedToolIds.length > 0}
                onChange={(e) => singleShot.setStream(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
              />
              Stream
            </label>
          </div>

          {toolsPage && toolsPage.data.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <ToolPicker
                tools={toolsPage.data}
                selectedIds={attachedToolIds}
                onChange={setAttachedToolIds}
                disabled={running}
              />
              {attachedToolIds.length > 0 && (
                <p className="text-[12px] text-faint">
                  The model may call these tools before answering — http tools run automatically; others
                  will ask you for a result.
                </p>
              )}
            </div>
          )}

          {prompt.mode === 'messages' ? (
            <MessageListEditor
              messages={prompt.messages}
              onChange={prompt.updateMessage}
              onAdd={prompt.addMessage}
              onRemove={prompt.removeMessage}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {prompt.prompts && prompt.prompts.length === 0 ? (
                <p className="text-[13px] text-muted">
                  No prompts yet —{' '}
                  <Link to="/prompts" className="text-accent hover:underline">
                    create one
                  </Link>{' '}
                  to reference it here.
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Prompt name" htmlFor="pg-pname">
                    <Select
                      id="pg-pname"
                      value={prompt.promptId}
                      onChange={(e) => prompt.selectPromptId(e.target.value)}
                      className="font-mono"
                    >
                      {prompt.promptOptions?.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Alias" htmlFor="pg-palias">
                    {prompt.aliases && prompt.aliases.length > 0 ? (
                      <Select
                        id="pg-palias"
                        value={prompt.promptAlias}
                        onChange={(e) => prompt.selectPromptAlias(e.target.value)}
                        className="font-mono"
                      >
                        {prompt.aliases.map((a) => (
                          <option key={a.alias} value={a.alias}>
                            {a.alias} · v{a.versionNumber}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <div className="flex h-9 items-center text-[13px] text-muted">
                        No aliases on this prompt yet.
                      </div>
                    )}
                  </Field>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
                    Template messages
                  </span>
                  {prompt.promptMessagesDirty && (
                    <Button size="sm" variant="ghost" onClick={prompt.resetPromptMessages}>
                      Reset to saved
                    </Button>
                  )}
                </div>
                <MessageListEditor
                  messages={prompt.promptMessages}
                  onChange={prompt.updatePromptMessage}
                  onAdd={prompt.addPromptMessage}
                  onRemove={prompt.removePromptMessage}
                />
              </div>
              <Field label="Variables (JSON)" htmlFor="pg-pvars">
                <Textarea
                  id="pg-pvars"
                  mono
                  rows={4}
                  value={prompt.promptVars}
                  onChange={(e) => prompt.setPromptVars(e.target.value)}
                  placeholder={'{\n  "name": "Alice"\n}'}
                />
              </Field>
              <p className="text-[12px] text-faint">
                {prompt.promptMessagesDirty
                  ? 'Templates edited — the gateway will render these messages with your variables (not the stored version).'
                  : 'Renders a stored prompt and stamps its version on the request — the prompt → cost lineage.'}
              </p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={!canWrite || running} onClick={send}>
              {running
                ? 'Running…'
                : attachedToolIds.length > 0
                  ? 'Send completion'
                  : singleShot.stream
                    ? 'Stream completion'
                    : 'Send completion'}
            </Button>
            <div ref={saveMenu.saveMenuRef} className="relative">
              <Button
                variant="default"
                disabled={!canSave || saveMenu.commitVersion.isPending}
                aria-haspopup="menu"
                aria-expanded={saveMenu.saveMenuOpen}
                onClick={() => saveMenu.setSaveMenuOpen((o) => !o)}
              >
                Save ▾
              </Button>
              {saveMenu.saveMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-0 top-full z-20 mt-1 min-w-[220px] rounded-md border border-line bg-surface py-1 shadow-lg"
                >
                  {prompt.saveTargetPromptId ? (
                    <>
                      {/* Known target → one-click save, no picker. */}
                      <button
                        type="button"
                        role="menuitem"
                        disabled={saveMenu.commitVersion.isPending}
                        onClick={saveMenu.saveNewVersion}
                        className="block w-full px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Save as new version of {prompt.saveTargetPromptName ?? 'prompt'}
                      </button>
                      {/* Rare case: target a different existing prompt. */}
                      <button
                        type="button"
                        role="menuitem"
                        disabled={saveMenu.commitVersion.isPending}
                        onClick={() => {
                          saveMenu.setSaveMenuOpen(false);
                          saveMenu.setSaveVersionDialogOpen(true);
                        }}
                        className="block w-full px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Save to a different prompt…
                      </button>
                    </>
                  ) : (
                    /* No known target (Messages mode, no context) → must pick. */
                    <button
                      type="button"
                      role="menuitem"
                      disabled={saveMenu.commitVersion.isPending}
                      onClick={() => {
                        saveMenu.setSaveMenuOpen(false);
                        saveMenu.setSaveVersionDialogOpen(true);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Save as new version of…
                    </button>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={saveMenu.commitVersion.isPending}
                    onClick={() => {
                      saveMenu.setSaveMenuOpen(false);
                      saveMenu.setSaveDialogOpen(true);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Save as new prompt…
                  </button>
                </div>
              )}
            </div>
            {!canWrite && (
              <span className="text-[12.5px] text-muted">
                Viewers can browse but can’t run completions — they spend money.
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Tool calls in flight (TC5) */}
      {toolLoop.activeCalls.length > 0 && (
        <section className="flex flex-col gap-3">
          {toolLoop.activeCalls.map((c) => (
            <ToolCallCard
              key={c.id}
              call={c}
              status={c.status}
              result={c.result}
              error={c.error}
              onRerun={c.status === 'error' ? () => toolLoop.retryCall(c.id) : undefined}
              onManualSubmit={
                c.status === 'manual' ? (value) => toolLoop.submitManualResult(c.id, value) : undefined
              }
            />
          ))}
        </section>
      )}

      {/* Signature: gateway telemetry */}
      <Telemetry
        state={telemetry.state}
        meta={telemetry.meta}
        latencyMs={telemetry.latencyMs}
        usage={telemetry.usage}
      />

      {/* Response */}
      <section className="rounded-xl border border-line bg-surface">
        <div className="border-b border-line-soft px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
            Response
          </span>
        </div>
        <div className="p-4">
          {telemetry.error ? (
            <p className="font-mono text-[13px] text-danger">{telemetry.error}</p>
          ) : telemetry.response ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-ink">
              {telemetry.response}
              {running && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />}
            </pre>
          ) : (
            <p className="text-[13px] text-faint">
              {running ? 'Waiting for the model…' : 'The completion will appear here.'}
            </p>
          )}
        </div>
      </section>

      <SavePromptDialog
        messages={messagesToSave}
        open={saveMenu.saveDialogOpen}
        onClose={() => saveMenu.setSaveDialogOpen(false)}
        onSaved={(newPromptId, name) => {
          saveMenu.setSaveDialogOpen(false);
          // Retarget "New version" at the prompt just created, so the very
          // next click can add v2 without switching mode or re-selecting it.
          saveMenu.retarget(newPromptId, name);
        }}
      />

      <SaveVersionDialog
        messages={messagesToSave}
        open={saveMenu.saveVersionDialogOpen}
        defaultPromptId={prompt.saveTargetPromptId ?? prompt.promptId ?? null}
        models={prompt.models ?? []}
        defaultModel={prompt.model.trim() || null}
        onClose={() => saveMenu.setSaveVersionDialogOpen(false)}
        onSaved={(updatedPromptId, name) => {
          saveMenu.setSaveVersionDialogOpen(false);
          // Retarget the quick "New version of…" action at the prompt just
          // updated, so a follow-up save defaults to the same prompt.
          saveMenu.retarget(updatedPromptId, name);
        }}
      />
    </div>
  );
}
