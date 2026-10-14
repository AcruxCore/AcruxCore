import { useState } from 'react';
import { useModels } from '@/api';
import { Button, Field, Select } from '@/ui';
import { ModelDialog } from '@/gateway/ModelDialog';

interface JudgeModelFieldProps {
  /** DOM id for the select; the label is tied to it. Unique per screen. */
  id: string;
  /** The selected `publicName`, or `''` while nothing is chosen. */
  value: string;
  onChange: (publicName: string) => void;
  /** What the judge grades on this screen, e.g. "every result". */
  grades: string;
  /** What the judge grades against, e.g. "the rule's criteria". Defaults to the example criteria. */
  against?: string;
}

/**
 * The required "Judge model" picker for every screen that grades with a judge:
 * running an experiment, optimizing a prompt, improving from feedback, and the
 * online-rule drawer.
 *
 * The platform has no default judge, so there is deliberately no "use the
 * default" option: the empty entry is a disabled prompt, and each screen blocks
 * submit until a model is chosen. The list is the team's own registered models
 * — the same names the server checks `judge_model` against. A team with none
 * gets a "Create model" button in place of the select.
 *
 * @param props - See {@link JudgeModelFieldProps}.
 */
export function JudgeModelField({ id, value, onChange, grades, against = 'the example criteria' }: JudgeModelFieldProps) {
  const gatewayModels = useModels();
  const [showCreateModel, setShowCreateModel] = useState(false);
  const models = gatewayModels.data ?? [];
  // Only a successful, empty list means "no models". A failed request must not
  // tell a team with models that it has none and push it to create a duplicate.
  const none = gatewayModels.isSuccess && models.length === 0;
  const failed = gatewayModels.isError;

  return (
    <Field
      label="Judge model"
      htmlFor={id}
      hint={
        none || failed
          ? undefined
          : `Required. The one model that grades ${grades} against ${against}. It does not have to be one of the models you are testing.`
      }
    >
      {failed ? (
        <div className="flex items-center gap-2 rounded-md border border-line-soft bg-bg p-2.5" data-testid={`${id}-load-error`}>
          <p className="flex-1 text-[12px] text-warn">Could not load your models.</p>
          <Button type="button" variant="default" onClick={() => void gatewayModels.refetch()}>
            Try again
          </Button>
        </div>
      ) : none ? (
        <div className="flex items-center gap-2 rounded-md border border-line-soft bg-bg p-2.5">
          <p className="flex-1 text-[12px] text-faint">No models registered yet.</p>
          <Button type="button" variant="default" onClick={() => setShowCreateModel(true)} data-testid={`${id}-create-model`}>
            Create model
          </Button>
        </div>
      ) : (
        <Select
          id={id}
          aria-label="Judge model"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={gatewayModels.isLoading}
          data-testid={id}
        >
          <option value="" disabled>
            Select a judge model…
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.publicName}>
              {m.publicName}
            </option>
          ))}
        </Select>
      )}
      <ModelDialog open={showCreateModel} onOpenChange={setShowCreateModel} />
    </Field>
  );
}
