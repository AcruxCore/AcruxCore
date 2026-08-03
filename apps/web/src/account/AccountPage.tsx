import {
  useCreatePersonalKey,
  usePersonalKeys,
  useRevokePersonalKey,
} from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ApiKeysPanel } from './ApiKeysPanel';
import { NotificationsPanel } from './NotificationsPanel';

/**
 * Account screen: identity summary, personal API keys, and per-team email
 * notification preferences.
 */
export function AccountPage() {
  const { me } = useAuth();
  const keys = usePersonalKeys();
  const create = useCreatePersonalKey();
  const revoke = useRevokePersonalKey();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Account &amp; keys</h1>
        <p className="mt-1 text-[13px] text-muted">
          Signed in as <span className="text-ink">{me?.user.email}</span>
          {me?.user.displayName ? ` · ${me.user.displayName}` : ''}
        </p>
      </header>

      <ApiKeysPanel
        title="Personal API keys"
        description="Use these with the SDK to fetch prompts at runtime."
        keys={keys.data}
        isLoading={keys.isLoading}
        canManage
        showSdkSnippet
        onCreate={(name) => create.mutateAsync({ name })}
        onRevoke={(id) => revoke.mutateAsync(id)}
      />

      <NotificationsPanel teamName={me?.team.name} />
    </div>
  );
}
