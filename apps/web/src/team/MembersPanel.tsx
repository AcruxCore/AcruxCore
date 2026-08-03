import { useState } from 'react';
import type { GrantableRole, MemberListItem } from '@/api';
import { ApiError, useMembers, useRemoveMember, useUpdateRole } from '@/api';
import { useAuth } from '@/auth/AuthContext';
import { timeAgo } from '@/lib/format';
import { Badge, Button, Dialog, DialogFooter, PageSpinner, useToast } from '@/ui';

const GRANTABLE: GrantableRole[] = ['admin', 'editor', 'viewer'];

/** Team members list with role editing and removal (owner/admin only). */
export function MembersPanel({ teamId }: { teamId: string }) {
  const { me, canManageTeam } = useAuth();
  const toast = useToast();
  const members = useMembers(teamId);
  const updateRole = useUpdateRole(teamId);
  const removeMember = useRemoveMember(teamId);

  const [editing, setEditing] = useState<MemberListItem | null>(null);
  const [role, setRole] = useState<GrantableRole>('viewer');
  const [removeTarget, setRemoveTarget] = useState<MemberListItem | null>(null);

  function openEdit(m: MemberListItem) {
    setEditing(m);
    setRole(GRANTABLE.includes(m.role as GrantableRole) ? (m.role as GrantableRole) : 'viewer');
  }

  async function saveRole() {
    if (!editing) return;
    try {
      await updateRole.mutateAsync({ userId: editing.userId, role });
      toast.success('Role updated');
      setEditing(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not update role.');
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    try {
      await removeMember.mutateAsync(removeTarget.userId);
      toast.success('Member removed');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not remove member.');
    } finally {
      setRemoveTarget(null);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line-soft p-4">
        <h2 className="text-[14px] font-semibold text-ink">Members</h2>
        <p className="mt-0.5 text-[12.5px] text-muted">People with access to this team.</p>
      </div>

      {members.isLoading ? (
        <div className="p-8">
          <PageSpinner />
        </div>
      ) : (
        <ul className="divide-y divide-line-soft">
          {(members.data ?? []).map((m) => {
            const isOwner = m.role === 'owner';
            const isSelf = m.userId === me?.user.id;
            return (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">
                    {m.email}
                    {isSelf && <span className="ml-2 text-[12px] text-faint">you</span>}
                  </p>
                  <p className="text-[12px] text-faint">joined {timeAgo(m.joinedAt)}</p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <Badge tone={isOwner ? 'prod' : 'default'}>{m.role}</Badge>
                  {canManageTeam && !isOwner && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => openEdit(m)}>
                        Edit role
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setRemoveTarget(m)}
                      >
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Edit role */}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={`Role for ${editing?.email ?? ''}`}
        description="Owner can't be granted here. Choose one role."
      >
        <div className="flex flex-col gap-2">
          {GRANTABLE.map((r) => (
            <label key={r} className="flex items-center gap-2.5 text-[13px] text-ink">
              <input
                type="radio"
                name="member-role"
                checked={role === r}
                onChange={() => setRole(r)}
              />
              <span className="capitalize">{r}</span>
              <span className="text-faint">
                {r === 'admin'
                  ? '— manage members, keys, and prompts'
                  : r === 'editor'
                    ? '— commit versions and promote'
                    : '— read-only'}
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={updateRole.isPending} onClick={saveRole}>
            {updateRole.isPending ? 'Saving…' : 'Save role'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Remove confirm */}
      <Dialog
        open={!!removeTarget}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title="Remove member?"
        description={`${removeTarget?.email ?? ''} will lose access to this team.`}
      >
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRemoveTarget(null)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={removeMember.isPending} onClick={confirmRemove}>
            {removeMember.isPending ? 'Removing…' : 'Remove member'}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
