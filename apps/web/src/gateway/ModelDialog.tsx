import { useEffect, useRef, useState } from 'react';
import type { CreateModelInput, GatewayModel, ListedProviderModel, UpdateModelInput } from '@/api';
import { useConnectionModels, useConnections, useCreateModel, useModels, useUpdateModel, ApiError } from '@/api';
import { Button, Combobox, Dialog, DialogFooter, Field, Input, Select, useToast } from '@/ui';
import { PROVIDER_LABELS } from './format';
import { CACHED_PRICE_FIELD_HINT, PRICE_FIELD_HINT } from './model-price';
import { copiedPrice, pricesFromListing, type PriceTexts } from './copied-prices';

export interface ModelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, the dialog edits this model instead of creating a new one. */
  model?: GatewayModel | null;
}

/** The three price inputs, for tracking which one holds text that is not a number. */
type PriceField = 'input' | 'output' | 'cached';

// Parses an optional price input: '' → undefined (omit), otherwise a number.
function parsePrice(v: string): number | null | undefined {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** A model's saved prices as form text. */
function savedPrices(m: GatewayModel): PriceTexts {
  const text = (v: number | null) => (v != null ? String(v) : '');
  return { input: text(m.inputPricePerM), output: text(m.outputPricePerM), cached: text(m.cachedInputPricePerM) };
}

/**
 * Create or edit a registered model: a public name → upstream model on a chosen
 * credential, with optional prices and an ordered fallback chain of other models.
 * Editing keeps the model's identity (public name stays callable).
 */
export function ModelDialog({ open, onOpenChange, model }: ModelDialogProps) {
  const editing = !!model;
  const toast = useToast();
  const { data: credentials } = useConnections();
  const { data: allModels } = useModels();
  const create = useCreateModel();
  const update = useUpdateModel();

  const [publicName, setPublicName] = useState('');
  const [upstreamModel, setUpstreamModel] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [cachedPrice, setCachedPrice] = useState('');
  // Price fields the browser cannot read as a number. A number input reports `value` as ''
  // for "0.3e", so without this a typo was saved as "blank" and cleared a stored price.
  const [badPrices, setBadPrices] = useState<Set<PriceField>>(new Set());
  const [fallbackIds, setFallbackIds] = useState<string[]>([]);
  // The prices the form filled in by itself: a model's saved prices when it opens for
  // editing, then the prices copied for each pick. Picking another model replaces these but
  // never a price the user typed. A ref, so a pick in the same render as the reset reads it.
  const autoPrices = useRef<PriceTexts | null>(null);
  // The upstream model as last set by the reset or a pick, for the same reason.
  const upstreamRef = useRef('');
  // The prices last copied from a provider's list, with the model and provider they came
  // from. The note under the prices shows while a field still holds one of them.
  const [copied, setCopied] = useState<{ prices: PriceTexts; model: string; provider: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (model) {
      setPublicName(model.publicName);
      setUpstreamModel(model.upstreamModel);
      upstreamRef.current = model.upstreamModel;
      autoPrices.current = savedPrices(model);
      setCredentialId(model.credentialId);
      const saved = savedPrices(model);
      setInputPrice(saved.input);
      setOutputPrice(saved.output);
      setCachedPrice(saved.cached);
      setFallbackIds(model.fallbacks.map((f) => f.id));
    } else {
      setPublicName('');
      setUpstreamModel('');
      upstreamRef.current = '';
      autoPrices.current = null;
      setCredentialId(credentials?.[0]?.id ?? '');
      setInputPrice('');
      setOutputPrice('');
      setCachedPrice('');
      setFallbackIds([]);
    }
    setBadPrices(new Set());
    setCopied(null);
  }, [open, model, credentials]);

  // Records the text and whether the browser could read it as a number. Both run on the
  // native `input` event: React's onChange skips an edit that leaves `value` unchanged, and
  // clearing "0.3e" goes from '' to '', so the error would never clear.
  function priceInputProps(field: PriceField, set: (v: string) => void) {
    return {
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(e.target.value),
      onInput: (e: React.FormEvent<HTMLInputElement>) => {
        const bad = e.currentTarget.validity.badInput;
        setBadPrices((cur) => {
          if (cur.has(field) === bad) return cur;
          const next = new Set(cur);
          if (bad) next.add(field);
          else next.delete(field);
          return next;
        });
      },
    };
  }
  const priceError = (field: PriceField) => (badPrices.has(field) ? 'Enter a number, or leave it blank.' : undefined);

  const busy = create.isPending || update.isPending;
  const selectedCred = credentials?.find((c) => c.id === credentialId);
  // The credential's own model list, for the upstream-model picker. Read only while the
  // dialog is open; if it fails, the field still takes a typed id.
  const listed = useConnectionModels(credentialId, open);
  const listedModels = listed.data?.ok ? (listed.data.models ?? []) : undefined;
  const pickerOptions = (listedModels ?? []).map((m) => ({ value: m.id }));

  const providerName = selectedCred ? PROVIDER_LABELS[selectedCred.provider] : 'the provider';

  /**
   * Fills the price fields for an upstream model: its listed prices, or, when an edit goes
   * back to the model's own upstream model, its saved prices. Each field changes only while
   * it is blank or still holds a filled-in price. The updaters read the latest queued text,
   * so this is safe in the same render as the reset.
   */
  function fillPrices(upstream: string, list: ListedProviderModel[] | undefined) {
    const id = upstream.trim();
    const own = model && id === model.upstreamModel;
    let next: PriceTexts | null;
    if (own) next = savedPrices(model);
    else if (list) next = pricesFromListing(list.find((m) => m.id === id)?.pricing);
    else return; // No list for this credential: leave the fields as they are.
    const prev = autoPrices.current;
    setInputPrice((cur) => copiedPrice('input', cur, prev, next));
    setOutputPrice((cur) => copiedPrice('output', cur, prev, next));
    setCachedPrice((cur) => copiedPrice('cached', cur, prev, next));
    autoPrices.current = next;
    setCopied(next && !own ? { prices: next, model: id, provider: providerName } : null);
  }

  /** A pick or a keystroke in the upstream-model field. */
  function pickUpstream(value: string) {
    setUpstreamModel(value);
    upstreamRef.current = value;
    fillPrices(value, listedModels);
  }

  // A list that arrives after the pick (it was still loading, or the credential changed)
  // fills the prices for the model already in the field. Only a new list runs this; reopening
  // the dialog with a cached list does not.
  useEffect(() => {
    if (!open || !listedModels) return;
    fillPrices(upstreamRef.current, listedModels);
    // fillPrices reads the rest through refs and state updaters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listedModels]);

  // The note shows while a field still holds a price copied from the list.
  const showCopiedNote =
    copied !== null &&
    (['input', 'output', 'cached'] as const).some(
      (f) => copied.prices[f] !== '' && { input: inputPrice, output: outputPrice, cached: cachedPrice }[f] === copied.prices[f],
    );

  let upstreamHint: string;
  if (listed.isFetching && !listed.data) {
    upstreamHint = `Loading the models this ${providerName} key can call…`;
  } else if (listedModels) {
    upstreamHint = `${listedModels.length} models. Type to search, or type an id that is not listed.`;
  } else if (listed.data && !listed.data.ok) {
    upstreamHint = `Could not load the model list: ${listed.data.error ?? 'unknown error'}. Type the model id.`;
  } else {
    upstreamHint = `The exact model id ${providerName} expects.`;
  }
  // Candidate fallbacks: every other registered model (can't fall back to itself).
  const fallbackChoices = (allModels ?? []).filter((m) => m.id !== model?.id);

  // Toggle a fallback id, preserving selection order (= call order).
  function toggleFallback(id: string) {
    setFallbackIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  async function handleSubmit() {
    try {
      if (editing && model) {
        const body: UpdateModelInput = {
          publicName: publicName.trim(),
          upstreamModel: upstreamModel.trim(),
          credentialId,
          fallbackModelIds: fallbackIds,
        };
        const ip = parsePrice(inputPrice);
        const op = parsePrice(outputPrice);
        // A cleared field sends null, so a stored price is removed rather than kept: picking
        // a model the list has no price for clears the old model's prices from the form.
        if (ip !== undefined) body.inputPricePerM = ip;
        else if (model.inputPricePerM != null) body.inputPricePerM = null;
        if (op !== undefined) body.outputPricePerM = op;
        else if (model.outputPricePerM != null) body.outputPricePerM = null;
        // A cleared cached price goes back to the provider's default cache rate.
        const cp = parsePrice(cachedPrice);
        if (cp !== undefined) body.cachedInputPricePerM = cp;
        else if (model.cachedInputPricePerM != null) body.cachedInputPricePerM = null;
        await update.mutateAsync({ id: model.id, body });
        toast.success('Model updated');
      } else {
        const body: CreateModelInput = {
          publicName: publicName.trim(),
          upstreamModel: upstreamModel.trim(),
          credentialId,
          fallbackModelIds: fallbackIds,
        };
        const ip = parsePrice(inputPrice);
        const op = parsePrice(outputPrice);
        if (ip !== undefined) body.inputPricePerM = ip;
        if (op !== undefined) body.outputPricePerM = op;
        const cp = parsePrice(cachedPrice);
        if (cp !== undefined) body.cachedInputPricePerM = cp;
        await create.mutateAsync(body);
        toast.success('Model registered');
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not save model');
    }
  }

  const canSubmit = publicName.trim() && upstreamModel.trim() && credentialId && badPrices.size === 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? 'Edit model' : 'New model'}
      description={
        editing
          ? 'Change the upstream model, credential, price, or fallbacks. The public name stays callable.'
          : 'Point a public name at an upstream model on one of your credentials.'
      }
    >
      {!credentials || credentials.length === 0 ? (
        <p className="rounded-md border border-line-soft bg-bg p-3 text-[13px] text-muted">
          Add a credential first — a model needs a provider key to call.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <Field
            label="Public name"
            htmlFor="model-public"
            hint="What callers send as “model”, e.g. fast-claude."
          >
            <Input
              id="model-public"
              value={publicName}
              onChange={(e) => setPublicName(e.target.value)}
              placeholder="fast-claude"
              className="font-mono"
            />
          </Field>

          <Field label="Credential" htmlFor="model-cred">
            <Select id="model-cred" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
              {credentials.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} · {PROVIDER_LABELS[c.provider]}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Upstream model"
            htmlFor="model-upstream"
            hint={upstreamHint}
          >
            <Combobox
              id="model-upstream"
              options={pickerOptions}
              value={upstreamModel}
              onChange={pickUpstream}
              placeholder={listedModels ? 'Search models' : 'gpt-4o-mini'}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Input $/1M" htmlFor="model-in" hint={PRICE_FIELD_HINT} error={priceError('input')}>
              <Input
                id="model-in"
                type="number"
                min="0"
                step="0.01"
                value={inputPrice}
                {...priceInputProps('input', setInputPrice)}
                placeholder="none"
              />
            </Field>
            <Field label="Output $/1M" htmlFor="model-out" hint={PRICE_FIELD_HINT} error={priceError('output')}>
              <Input
                id="model-out"
                type="number"
                min="0"
                step="0.01"
                value={outputPrice}
                {...priceInputProps('output', setOutputPrice)}
                placeholder="none"
              />
            </Field>
          </div>

          {showCopiedNote && copied && (
            <p className="-mt-1 text-[12px] text-muted">
              Prices copied from {copied.provider}&rsquo;s model list for{' '}
              <span className="font-mono">{copied.model}</span>. Check them before saving.
            </p>
          )}

          <Field
            label="Cached input $/1M"
            htmlFor="model-cached"
            hint={CACHED_PRICE_FIELD_HINT}
            error={priceError('cached')}
          >
            <Input
              id="model-cached"
              type="number"
              min="0"
              step="0.01"
              value={cachedPrice}
              {...priceInputProps('cached', setCachedPrice)}
              placeholder="default"
            />
          </Field>

          {fallbackChoices.length > 0 && (
            <Field label="Fallbacks" htmlFor="model-fallbacks" hint="Tried in order if this model fails.">
              {/* Capped and scrolling for the same reason as the evaluation
                  model picker: an uncapped list grows with the registry until
                  it pushes this dialog's own buttons off the bottom of the
                  screen, which is where I found it. */}
              <div id="model-fallbacks" className="flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-md border border-line-soft bg-bg p-2.5">
                {fallbackChoices.map((m) => {
                  const pos = fallbackIds.indexOf(m.id);
                  return (
                    <label key={m.id} className="flex items-center gap-2 text-[13px] text-ink">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-[var(--accent)]"
                        checked={pos !== -1}
                        onChange={() => toggleFallback(m.id)}
                      />
                      <span className="font-mono">{m.publicName}</span>
                      <span className="text-faint">→ {m.upstreamModel}</span>
                      {pos !== -1 && <span className="ml-auto text-[11px] text-muted">#{pos + 1}</span>}
                    </label>
                  );
                })}
              </div>
            </Field>
          )}
        </div>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={busy || !canSubmit} onClick={handleSubmit}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Register model'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
