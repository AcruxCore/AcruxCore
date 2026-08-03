import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CompletionBody, MessageRole } from '@/api';
import { useAliases, useModels, usePrompts, useVersion, useVersionById } from '@/api';
import type { PlaygroundPrefill } from '../playground-prefill';
import { resolveModelPublicName } from '../playground-prefill';
import type { DraftMessage } from './MessageListEditor';

export type Mode = 'messages' | 'prompt';

/**
 * Owns everything about *what* the next request will say: the Messages vs.
 * Stored-prompt tab, the model picker (including trace/feedback prefill
 * resolution), the selected prompt/alias/version and its raw template
 * messages, and the "Save ▾" target those imply. Also builds the request
 * body from all of the above.
 *
 * This is the single largest slice of Playground state because it's one
 * cohesive concern with load-bearing effect ordering (see the inline
 * comments) — splitting it further would only scatter that ordering across
 * files without reducing it.
 */
export function usePromptSelection() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: models } = useModels();
  const { data: promptPage } = usePrompts({ page: 1 });
  const prompts = promptPage?.data;

  const [mode, setMode] = useState<Mode>('messages');
  const [model, setModel] = useState('');

  // A model string carried in from a trace/feedback prefill, awaiting
  // resolution against the registered models. A span records the *upstream*
  // model (e.g. `xiaomi/mimo-v2.5-20260422`), which the picker and gateway
  // don't key on — the resolver effect below maps it to a `publicName`. Kept
  // separate from `model` (and applied only once `models` load) so the raw
  // string never reaches the request body.
  const [pendingSpanModel, setPendingSpanModel] = useState<string | null>(null);

  // Default the picker to the first registered model once they load — but stand
  // aside while a span model is pending, so the resolver below owns the pick and
  // there's no race between the two effects (both key on `models`).
  useEffect(() => {
    if (pendingSpanModel) return;
    if (!model && models && models.length > 0) setModel(models[0].publicName);
  }, [models, model, pendingSpanModel]);

  // Resolve a prefilled span model to a registered `publicName`, or fall back to
  // the first model if it no longer matches (renamed/deleted deployment). Owns
  // the fallback itself so exactly one effect sets the model on the prefill
  // path — deterministic regardless of effect order.
  useEffect(() => {
    if (!pendingSpanModel || !models || models.length === 0) return;
    setModel(resolveModelPublicName(pendingSpanModel, models) ?? models[0].publicName);
    setPendingSpanModel(null);
  }, [pendingSpanModel, models]);

  const [messages, setMessages] = useState<DraftMessage[]>([
    { role: 'user', content: 'Say hello in one short sentence.' },
  ]);
  const [promptId, setPromptId] = useState('');
  const [promptAlias, setPromptAlias] = useState('production');
  const [promptVars, setPromptVars] = useState('');

  // A trace/feedback-prefilled prompt may not be on page 1 of `usePrompts`
  // (F3 — Task 5), which would otherwise leave the picker showing a blank
  // value. `useVersionById` (below) already resolves the prompt's name, so
  // stash it here and inject it as a synthetic option when it's missing from
  // the loaded page — the editor and Save menu key off `promptId`/
  // `saveTargetPromptId`, never off this option list, so they work regardless.
  const [prefillPromptMeta, setPrefillPromptMeta] = useState<{ id: string; name: string } | null>(
    null,
  );
  const promptOptions =
    prompts && promptId && prefillPromptMeta?.id === promptId && !prompts.some((p) => p.id === promptId)
      ? [prefillPromptMeta, ...prompts]
      : prompts;

  // Selected prompt drives its name (sent to the gateway) and its alias list.
  const selectedPrompt = promptOptions?.find((p) => p.id === promptId);
  const { data: aliases } = useAliases(promptId);

  // The prompt the "Save ▾ → New version" action commits to, and its display
  // name. Real state (not derived from `mode`/`selectedPrompt` via an effect)
  // because that pattern fights the trace-prefill flow below: `selectedPrompt`
  // comes from the paginated `usePrompts` list, which may not contain a
  // prefilled prompt, so a derivation effect would null the target back out
  // right after prefill sets it. Instead this is set explicitly at every
  // point the target legitimately changes: switching the "Stored prompt" tab,
  // picking a different prompt, a trace prefill resolving, or "Save as new
  // prompt" completing (see `selectMode`, `selectPromptId`, the prefill
  // effects, and `SavePromptDialog`'s `onSaved` in the page component).
  const [saveTargetPromptId, setSaveTargetPromptId] = useState<string | null>(null);
  const [saveTargetPromptName, setSaveTargetPromptName] = useState<string | null>(null);

  /** Switches the request-builder tab, syncing the Save-menu target with it. */
  function selectMode(next: Mode) {
    setMode(next);
    if (next === 'prompt') {
      if (promptId) {
        setSaveTargetPromptId(promptId);
        setSaveTargetPromptName(selectedPrompt?.name ?? null);
      }
    } else {
      setSaveTargetPromptId(null);
      setSaveTargetPromptName(null);
    }
  }

  /** Picks a different stored prompt, syncing the Save-menu target with it. */
  function selectPromptId(id: string) {
    setPromptId(id);
    setSaveTargetPromptId(id);
    setSaveTargetPromptName(promptOptions?.find((p) => p.id === id)?.name ?? null);
    // Discard any in-progress edits so the newly selected prompt's version can
    // hydrate — otherwise the dirty guard below would keep showing the
    // previous prompt's edited draft under the new selection.
    setPromptMessagesDirty(false);
    setLoadedVersionId(null);
  }

  /** Picks a different alias for the current prompt, discarding in-progress edits
   * so the newly selected alias's version can hydrate (same reasoning as
   * `selectPromptId` above). */
  function selectPromptAlias(alias: string) {
    setPromptAlias(alias);
    setPromptMessagesDirty(false);
    setLoadedVersionId(null);
  }

  // Default the prompt picker to the first prompt once they load.
  useEffect(() => {
    if (!promptId && prompts && prompts.length > 0) setPromptId(prompts[0].id);
  }, [prompts, promptId]);

  // Keep the alias valid for the selected prompt: prefer `production`, else the
  // first available. Reset whenever the alias list changes (i.e. prompt switch).
  useEffect(() => {
    if (!aliases || aliases.length === 0) return;
    const names = aliases.map((a) => a.alias);
    if (!names.includes(promptAlias)) {
      setPromptAlias(names.includes('production') ? 'production' : names[0]);
    }
  }, [aliases, promptAlias]);

  // Raw template messages loaded from the selected stored prompt version.
  const [promptMessages, setPromptMessages] = useState<DraftMessage[]>([]);
  const [promptMessagesDirty, setPromptMessagesDirty] = useState(false);
  const [loadedVersionId, setLoadedVersionId] = useState<string | null>(null);

  // The alias row carries versionNumber; fetch that version's raw messages.
  const activeAlias = aliases?.find((a) => a.alias === promptAlias) ?? null;
  const { data: loadedVersion } = useVersion(promptId, activeAlias?.versionNumber ?? null);

  useEffect(() => {
    if (!loadedVersion) return;
    // Only (re)hydrate when the ACTUAL version changed — not on every TanStack
    // refetch (refetchOnWindowFocus hands back a new object reference for the
    // same version). And never clobber in-progress edits. This prevents a
    // background refetch from silently wiping the user's edits.
    if (loadedVersion.id === loadedVersionId) return;
    if (promptMessagesDirty) return;
    setPromptMessages(
      loadedVersion.messages.map((m) => ({ role: m.role as MessageRole, content: m.content })),
    );
    setPromptMessagesDirty(false);
    setLoadedVersionId(loadedVersion.id);
  }, [loadedVersion, loadedVersionId, promptMessagesDirty]);

  // #12: pre-select a stored version's bound default model. Runs only in
  // stored-prompt mode (the picker is shared with Messages mode, so a
  // background-loaded prompt must not override the model there) and applies
  // once per version — so switching prompt/alias re-applies, but a later manual
  // change to the picker is never clobbered. A pending trace-span model prefill
  // still owns the pick.
  const [modelBoundForVersionId, setModelBoundForVersionId] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'prompt' || pendingSpanModel) return;
    if (!loadedVersion?.model) return;
    if (loadedVersion.id === modelBoundForVersionId) return;
    setModel(loadedVersion.model);
    setModelBoundForVersionId(loadedVersion.id);
  }, [mode, loadedVersion, pendingSpanModel, modelBoundForVersionId]);

  // Trace/feedback → Playground prefill (F3): the location state set by
  // `SpanPanel`'s "Open in Playground →" button (via `buildPrefillFromSpan`).
  // Applied at most once per navigation — guarded by `prefillApplied` so a
  // background re-render can't re-apply and clobber whatever the user has
  // since typed (same clobber class as Task 3's dirty-editor guard).
  const [prefillApplied, setPrefillApplied] = useState(false);
  const prefill = prefillApplied ? null : (location.state as PlaygroundPrefill | null);
  const { data: resolvedPrefillVersion } = useVersionById(prefill?.promptVersionId ?? null);

  // No prompt lineage on the span (raw messages, or model-only) — nothing to
  // resolve, so this applies synchronously.
  useEffect(() => {
    if (!prefill || prefill.promptVersionId) return;
    if (prefill.model) setPendingSpanModel(prefill.model);
    if (prefill.messages) {
      setMode('messages');
      setMessages(prefill.messages);
    }
    setPrefillApplied(true);
    navigate('.', { replace: true, state: null });
  }, [prefill, navigate]);

  // Prompt lineage on the span — wait for `useVersionById` to resolve the
  // version UUID to its prompt + raw messages, then switch to Stored-prompt
  // mode pointed at `production` (the exact version the span used may have
  // moved on by now; `production` is the sensible tab to land on, matching
  // how the picker itself defaults).
  useEffect(() => {
    if (!prefill?.promptVersionId || !resolvedPrefillVersion) return;
    setMode('prompt');
    setPromptId(resolvedPrefillVersion.promptId);
    setPromptAlias('production');
    setPrefillPromptMeta({
      id: resolvedPrefillVersion.promptId,
      name: resolvedPrefillVersion.promptName,
    });
    setSaveTargetPromptId(resolvedPrefillVersion.promptId);
    setSaveTargetPromptName(resolvedPrefillVersion.promptName);
    setPromptMessages(resolvedPrefillVersion.messages);
    // Mark the prefilled span content dirty so the alias-hydration effect
    // (which skips while dirty) can never overwrite it with `production`'s
    // current content, and so `buildBody()` sends these exact messages +
    // variables instead of a `production` reference — trading the prompt-ref
    // lineage stamp for fidelity to the span that was opened (Task 5 fix).
    setPromptMessagesDirty(true);
    setLoadedVersionId(prefill.promptVersionId ?? null);
    if (prefill.model) setPendingSpanModel(prefill.model);
    if (prefill.variables) setPromptVars(JSON.stringify(prefill.variables, null, 2));
    setPrefillApplied(true);
    navigate('.', { replace: true, state: null });
  }, [prefill, resolvedPrefillVersion, navigate]);

  function updateMessage(i: number, patch: Partial<DraftMessage>) {
    setMessages((ms) => ms.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  }
  function addMessage() {
    setMessages((ms) => [...ms, { role: 'user', content: '' }]);
  }
  function removeMessage(i: number) {
    setMessages((ms) => ms.filter((_, idx) => idx !== i));
  }

  // Stored-prompt template edits — every mutation marks the draft dirty so
  // send() knows to render client-side templates rather than reference lineage.
  function updatePromptMessage(i: number, patch: Partial<DraftMessage>) {
    setPromptMessages((ms) => ms.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
    setPromptMessagesDirty(true);
  }
  function addPromptMessage() {
    setPromptMessages((ms) => [...ms, { role: 'user', content: '' }]);
    setPromptMessagesDirty(true);
  }
  function removePromptMessage(i: number) {
    setPromptMessages((ms) => ms.filter((_, idx) => idx !== i));
    setPromptMessagesDirty(true);
  }
  /** Discard edits and re-hydrate from the currently-loaded saved version. */
  function resetPromptMessages() {
    if (!loadedVersion) return;
    setPromptMessages(
      loadedVersion.messages.map((m) => ({ role: m.role as MessageRole, content: m.content })),
    );
    setPromptMessagesDirty(false);
    setLoadedVersionId(loadedVersion.id);
  }

  const [temperature, setTemperature] = useState('0');
  const [maxTokens, setMaxTokens] = useState('256');

  /** Assemble the request body, throwing a user-facing error on invalid input. */
  function buildBody(): CompletionBody {
    if (!model.trim()) throw new Error('Enter a model.');
    const body: CompletionBody = { model: model.trim() };
    if (temperature.trim() !== '') body.temperature = Number(temperature);
    if (maxTokens.trim() !== '') body.max_tokens = Number(maxTokens);

    if (mode === 'messages') {
      const cleaned = messages.filter((m) => m.content.trim() !== '');
      if (cleaned.length === 0) throw new Error('Add at least one message with content.');
      body.messages = cleaned;
    } else {
      if (!selectedPrompt || !promptAlias) throw new Error('Select a prompt and alias.');
      let variables: Record<string, unknown> = {};
      if (promptVars.trim() !== '') {
        try {
          variables = JSON.parse(promptVars);
        } catch {
          throw new Error('Variables must be valid JSON.');
        }
      }
      if (promptMessagesDirty) {
        // Edited experiment: send the raw templates + variables; gateway renders (B1).
        const cleaned = promptMessages.filter((m) => m.content.trim() !== '');
        if (cleaned.length === 0) throw new Error('Add at least one message with content.');
        body.messages = cleaned;
        body.variables = variables;
      } else {
        // Untouched: reference the stored version so prompt lineage is stamped (G8).
        body.prompt = { name: selectedPrompt.name, alias: promptAlias, variables };
      }
    }
    return body;
  }

  return {
    models,
    mode,
    selectMode,
    model,
    setModel,
    messages,
    updateMessage,
    addMessage,
    removeMessage,
    prompts,
    promptId,
    selectPromptId,
    promptAlias,
    selectPromptAlias,
    promptVars,
    setPromptVars,
    promptOptions,
    selectedPrompt,
    aliases,
    promptMessages,
    promptMessagesDirty,
    updatePromptMessage,
    addPromptMessage,
    removePromptMessage,
    resetPromptMessages,
    saveTargetPromptId,
    setSaveTargetPromptId,
    saveTargetPromptName,
    setSaveTargetPromptName,
    temperature,
    setTemperature,
    maxTokens,
    setMaxTokens,
    buildBody,
  };
}

export type PromptSelection = ReturnType<typeof usePromptSelection>;
