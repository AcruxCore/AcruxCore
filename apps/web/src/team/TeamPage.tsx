import { useCreateTeamKey, useRevokeTeamKey, useTeamKeys } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { ApiKeysPanel } from '@/account/ApiKeysPanel';
import { MembersPanel } from './MembersPanel';
import { InvitesPanel } from './InvitesPanel';

/** Team screen: members, invites, and team-scoped API keys for the current team. */
export function TeamPage() {
  const { me, canManageTeam } = useAuth();
  const teamId = me?.team.id ?? '';

  const teamKeys = useTeamKeys(teamId);
  const createKey = useCreateTeamKey(teamId);
  const revokeKey = useRevokeTeamKey(teamId);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Team</h1>
        <p className="mt-1 text-[13px] text-muted">
          <span className="text-ink">{me?.team.name}</span> · manage who has access and how
          services authenticate.
        </p>
      </header>

      <MembersPanel teamId={teamId} />
      {canManageTeam && <InvitesPanel teamId={teamId} />}
      {canManageTeam && (
        <ApiKeysPanel
          title="Team API keys"
          description="Keys for CI and services — not tied to any one person."
          keys={teamKeys.data}
          isLoading={teamKeys.isLoading}
          canManage
          showSdkSnippet
          onCreate={(name) => createKey.mutateAsync({ name })}
          onRevoke={(id) => revokeKey.mutateAsync(id)}
        />
      )}
    </div>
  );
}
