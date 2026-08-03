import { Empty, PageSpinner, useToast } from '@/ui';
import { useAuth } from '@/auth/AuthContext';
import { useTraceSettings, useUpdateTraceSettings } from '@/api';

/**
 * Team-scoped observability settings: the payload-capture toggle. The switch is
 * disabled for editors/viewers (server enforces owner/admin on PUT /traces/settings);
 * a one-line note explains capture is on by default and stores message bodies.
 */
export function TraceSettingsPage() {
  const { canManageTeam } = useAuth();
  const toast = useToast();
  const { data, isLoading, isError } = useTraceSettings();
  const update = useUpdateTraceSettings();
  if (isLoading) return <PageSpinner />;
  if (isError || !data) {
    return <Empty title="Couldn’t load settings" description="Something went wrong. Try again." />;
  }

  const toggle = () =>
    update.mutate(
      { capturePayloads: !data.capturePayloads },
      { onSuccess: () => toast.success('Settings updated'), onError: () => toast.error('Could not update settings') },
    );

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Observability settings</h1>
        <p className="text-[13px] text-muted">Controls that apply to your whole team.</p>
      </header>
      <div className="flex items-start gap-4 rounded-xl border border-line bg-surface p-4">
        <div className="flex-1">
          <div className="text-[14px] font-medium">Capture payloads</div>
          <p className="mt-1 text-[13px] text-muted">
            On by default. When on, request/response message bodies are stored with each traced span so they show in
            the trace detail.
          </p>
          {!canManageTeam && <p className="mt-1 text-[12px] text-faint">Only owners and admins can change this.</p>}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={data.capturePayloads}
          disabled={!canManageTeam || update.isPending}
          onClick={toggle}
          data-testid="capture-toggle"
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
            data.capturePayloads ? 'bg-accent' : 'bg-line'
          }`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface transition-all ${
              data.capturePayloads ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
    </div>
  );
}
