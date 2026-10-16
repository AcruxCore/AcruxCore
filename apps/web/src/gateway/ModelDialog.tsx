import { useEffect, useState } from 'react';
import type { CreateModelInput, GatewayModel, UpdateModelInput } from '@/api';
import { useConnections, useCreateModel, useModels, useUpdateModel, ApiError } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Select, useToast } from '@/ui';
import { PROVIDER_LABELS } from './format';
import { CACHED_PRICE_FIELD_HINT, PRICE_FIELD_HINT } from './model-price';

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

  useEffect(() => {
    if (!open) return;
    if (model) {
      setPublicName(model.publicName);
      setUpstreamModel(model.upstreamModel);
      setCredentialId(model.credentialId);
      setInputPrice(model.inputPricePerM != null ? String(model.inputPricePerM) : '');
      setOutputPrice(model.outputPricePerM != null ? String(model.outputPricePerM) : '');
      setCachedPrice(model.cachedInputPricePerM != null ? String(model.cachedInputPricePerM) : '');
      setFallbackIds(model.fallbacks.map((f) => f.id));
    } else {
      setPublicName('');
      setUpstreamModel('');
      setCredentialId(credentials?.[0]?.id ?? '');
      setInputPrice('');
      setOutputPrice('');
      setCachedPrice('');
      setFallbackIds([]);
    }
    setBadPrices(new Set());
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
        if (ip !== undefined) body.inputPricePerM = ip;
        if (op !== undefined) body.outputPricePerM = op;
        // Unlike the two prices above, blanking this one means something: go back to the
        // provider's default rate. So a cleared field sends null rather than nothing.
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
            hint={
              selectedCred
                ? `Sent to ${PROVIDER_LABELS[selectedCred.provider]}, e.g. anthropic/claude-3.5-sonnet.`
                : 'The exact model id the provider expects.'
            }
          >
            <Input
              id="model-upstream"
              value={upstreamModel}
              onChange={(e) => setUpstreamModel(e.target.value)}
              placeholder="anthropic/claude-3.5-sonnet"
              className="font-mono"
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
                placeholder="auto"
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
                placeholder="auto"
              />
            </Field>
          </div>

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
