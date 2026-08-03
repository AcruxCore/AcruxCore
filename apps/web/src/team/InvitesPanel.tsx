import { useState } from 'react';
import type { GrantableRole } from '@/api';
import { ApiError, useCreateInvite, useInvites, useRevokeInvite } from '@/api';
import { timeAgo } from '@/lib/format';
import {
  Badge,
  Button,
  CopyButton,
  Dialog,
  DialogFooter,
  Empty,
  Field,
  Input,
  PageSpinner,
  useToast,
} from '@/ui';

const GRANTABLE: GrantableRole[] = ['admin', 'editor', 'viewer'];

/** Full invite URL for a token, based on the current origin. */
function inviteUrl(token: string): string {
  return `${window.location.origin}/invite/${token}`;
}

/** Create, share (copy link), and revoke single-use team invites. */
export function InvitesPanel({ teamId }: { teamId: string }) {
  const toast = useToast();
  const invites = useInvites(teamId);
  const createInvite = useCreateInvite(teamId);
  const revokeInvite = useRevokeInvite(teamId);

  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState<GrantableRole>('viewer');
  const [email, setEmail] = useState('');

  async function create() {
    const trimmed = email.trim();
    try {
      await createInvite.mutateAsync({ role, email: trimmed || undefined });
      toast.success(trimmed ? `Invite sent to ${trimmed}` : 'Invite link created');
      setCreating(false);
      setRole('viewer');
      setEmail('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not create invite.');
    }
  }

  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="flex items-start justify-between gap-4 border-b border-line-soft p-4">
        <div>
          <h2 className="text-[14px] font-semibold text-ink">Invites</h2>
          <p className="mt-0.5 text-[12.5px] text-muted">
            Single-use links, valid 7 days. Add an address to email the invite, or copy the link
            and share it yourself.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          New invite
        </Button>
      </div>

      {invites.isLoading ? (
        <div className="p-8">
          <PageSpinner />
        </div>
      ) : !invites.data || invites.data.length === 0 ? (
        <div className="p-4">
          <Empty title="No pending invites" description="Create a link to add a teammate." />
        </div>
      ) : (
        <ul className="divide-y divide-line-soft">
          {invites.data.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                {inv.email ? (
                  <span className="truncate text-[13px] text-ink">{inv.email}</span>
                ) : (
                  <code className="truncate rounded border border-line bg-bg px-2 py-1 font-mono text-[12px] text-muted">
                    /invite/{inv.token.slice(0, 10)}…
                  </code>
                )}
                <Badge>{inv.role}</Badge>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[12px] text-faint">expires {timeAgo(inv.expiresAt)}</span>
                <CopyButton value={inviteUrl(inv.token)} label="Copy link" />
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => revokeInvite.mutate(inv.id)}
                >
                  Revoke
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New invite link"
        description="Choose the role the invited teammate will receive. Add their email to send the invite for them."
      >
        <Field label="Email (optional)" htmlFor="invite-email">
          <Input
            id="invite-email"
            type="email"
            autoComplete="off"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <p className="mt-1 text-[12px] text-muted">
          Leave blank to create a link you share yourself.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {GRANTABLE.map((r) => (
            <label key={r} className="flex items-center gap-2.5 text-[13px] text-ink">
              <input type="radio" name="invite-role" checked={role === r} onChange={() => setRole(r)} />
              <span className="capitalize">{r}</span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setCreating(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={createInvite.isPending} onClick={create}>
            {createInvite.isPending
              ? email.trim()
                ? 'Sending…'
                : 'Creating…'
              : email.trim()
                ? 'Send invite'
                : 'Create link'}
          </Button>
        </DialogFooter>
      </Dialog>
    </section>
  );
}
