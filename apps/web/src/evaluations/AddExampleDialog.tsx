import { useEffect, useState } from 'react';
import { ApiError, useAddDatasetExample } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Textarea, useToast } from '@/ui';

export interface AddExampleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dataset the example is added to. */
  datasetId: string;
  /**
   * Variable names already used by this dataset's examples, if any. The form
   * starts pre-seeded with them so every example in a dataset ends up with the
   * same shape — which is what a run against one prompt needs.
   */
  knownVariables?: string[];
}

/** One editable `input` entry. `id` keeps React keys stable while rows are renamed. */
interface VariableRow {
  id: number;
  key: string;
  value: string;
}

let nextRowId = 0;
function makeRow(key = ''): VariableRow {
  return { id: nextRowId++, key, value: '' };
}

/**
 * Turns the variable rows into the `input` object the API expects. Rows with a
 * blank key are dropped, so a half-typed extra row never reaches the request.
 */
function rowsToInput(rows: VariableRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) out[key] = row.value;
  }
  return out;
}

/**
 * Adds one hand-authored example to a dataset (`POST /datasets/:id/examples`).
 *
 * Two input modes, because `input` is a free-form variable bag: named fields
 * cover the ordinary case where every variable is a string rendered into a
 * template, and a raw JSON mode covers values that are not strings — numbers,
 * lists, nested objects — which the field editor cannot express.
 */
export function AddExampleDialog({ open, onOpenChange, datasetId, knownVariables }: AddExampleDialogProps) {
  const toast = useToast();
  const add = useAddDatasetExample(datasetId);
  const [rows, setRows] = useState<VariableRow[]>([makeRow()]);
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState('{}');
  const [criteria, setCriteria] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset to a fresh form every time the dialog is (re)opened, seeded with the
  // dataset's existing variable names so examples stay consistent with each other.
  useEffect(() => {
    if (!open) return;
    const seeds = knownVariables?.length ? knownVariables : [''];
    setRows(seeds.map((k) => makeRow(k)));
    setJsonMode(false);
    setJson('{}');
    setCriteria('');
    setError(null);
  }, [open, knownVariables]);

  /** Switching to JSON carries the typed fields across, so nothing is silently lost. */
  function toggleJsonMode() {
    if (!jsonMode) setJson(JSON.stringify(rowsToInput(rows), null, 2));
    setJsonMode(!jsonMode);
    setError(null);
  }

  async function handleAdd() {
    let input: Record<string, unknown>;
    if (jsonMode) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        setError('That is not valid JSON.');
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setError('Input must be a JSON object of variable names to values.');
        return;
      }
      input = parsed as Record<string, unknown>;
    } else {
      input = rowsToInput(rows);
    }

    if (Object.keys(input).length === 0) {
      setError('Add at least one variable.');
      return;
    }

    setError(null);
    try {
      await add.mutateAsync({ input, criteria: criteria.trim() || undefined });
      toast.success('Example added');
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not add the example.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add example"
      description="One row of the dataset: the prompt variables to render, and what a good answer looks like."
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink">Input variables</span>
            <Button variant="ghost" size="sm" onClick={toggleJsonMode} data-testid="add-example-json-toggle">
              {jsonMode ? 'Edit as fields' : 'Edit as JSON'}
            </Button>
          </div>

          {jsonMode ? (
            <Textarea
              mono
              rows={6}
              value={json}
              onChange={(e) => setJson(e.target.value)}
              aria-label="Input variables as JSON"
              data-testid="add-example-json"
            />
          ) : (
            <div className="flex flex-col gap-2">
              {rows.map((row, i) => (
                <div key={row.id} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, key: e.target.value } : r)))
                    }
                    placeholder="variable"
                    aria-label={`Variable ${i + 1} name`}
                    className="max-w-[200px] font-mono"
                    data-testid="add-example-var-key"
                    // Without this the dialog's first focusable element is the
                    // JSON-mode toggle, so opening the form lands focus on the
                    // escape hatch rather than on the field to fill in.
                    autoFocus={i === 0}
                  />
                  <Input
                    value={row.value}
                    onChange={(e) =>
                      setRows((cur) => cur.map((r) => (r.id === row.id ? { ...r, value: e.target.value } : r)))
                    }
                    placeholder="value"
                    aria-label={`Variable ${i + 1} value`}
                    data-testid="add-example-var-value"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove variable ${i + 1}`}
                    disabled={rows.length === 1}
                    onClick={() => setRows((cur) => cur.filter((r) => r.id !== row.id))}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <div>
                <Button variant="ghost" size="sm" onClick={() => setRows((cur) => [...cur, makeRow()])}>
                  Add variable
                </Button>
              </div>
            </div>
          )}
          {error && <p className="text-[12px] text-danger">{error}</p>}
        </div>

        <Field
          label="Criteria"
          htmlFor="add-example-criteria"
          hint="Optional. What the judge should check for on this example."
        >
          <Textarea
            id="add-example-criteria"
            rows={3}
            value={criteria}
            onChange={(e) => setCriteria(e.target.value)}
            placeholder="Names the policy and quotes the refund window."
            data-testid="add-example-criteria"
          />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={add.isPending} onClick={handleAdd} data-testid="add-example-submit">
          {add.isPending ? 'Adding…' : 'Add example'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
