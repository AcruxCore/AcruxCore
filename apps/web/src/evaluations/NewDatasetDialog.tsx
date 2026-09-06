import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, useCreateDataset } from '@/api';
import { Button, Dialog, DialogFooter, Field, Input, Textarea, useToast } from '@/ui';

export interface NewDatasetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Creates an empty dataset from the Datasets page — the route into evaluation
 * for a team that has no feedback yet, and so cannot use the
 * build-from-feedback flow (`CreateDatasetDialog`). Posts `{ name,
 * overall_feedback }` to `POST /datasets` and navigates straight to the new
 * dataset, where examples are added by hand.
 */
export function NewDatasetDialog({ open, onOpenChange }: NewDatasetDialogProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const create = useCreateDataset();
  const [name, setName] = useState('');
  const [overallFeedback, setOverallFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset to a fresh form every time the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setName('');
      setOverallFeedback('');
      setError(null);
    }
  }, [open]);

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }
    setError(null);
    try {
      const created = await create.mutateAsync({
        name: trimmedName,
        overall_feedback: overallFeedback.trim() || undefined,
      });
      toast.success(`Created dataset "${created.name}"`);
      onOpenChange(false);
      // A dataset with no examples is not useful yet, so land on the page that
      // holds "Add example" rather than leaving the user on the list.
      navigate(`/evaluations/datasets/${created.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create dataset.');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New dataset"
      description="Starts empty. Add examples by hand on the next screen."
    >
      <div className="flex flex-col gap-4">
        <Field label="Name" htmlFor="new-dataset-name" error={error ?? undefined} hint="What this dataset is for.">
          <Input
            id="new-dataset-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="regression-suite"
            data-testid="new-dataset-name"
            autoFocus
          />
        </Field>
        <Field
          label="Overall feedback"
          htmlFor="new-dataset-overall-feedback"
          hint="Optional. Applied to every example by the judge, and shown to the optimizer."
        >
          <Textarea
            id="new-dataset-overall-feedback"
            rows={3}
            value={overallFeedback}
            onChange={(e) => setOverallFeedback(e.target.value)}
            placeholder="What these examples have in common."
          />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={create.isPending} onClick={handleCreate} data-testid="new-dataset-submit">
          {create.isPending ? 'Creating…' : 'Create dataset'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
