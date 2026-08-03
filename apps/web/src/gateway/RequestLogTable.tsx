import { useState } from 'react';
import type { ReactNode } from 'react';
import type { GatewayRequestItem, RequestStatus } from '@/api';
import { useGatewayRequests } from '@/api';
import { dateTime, timeAgo } from '@/lib/format';
import { Button, CopyButton, Dialog, Empty, Input, Select, Spinner } from '@/ui';
import { formatLatency, formatUsd } from './format';

const STATUS_STYLE: Record<RequestStatus, { dot: string; text: string; label: string }> = {
  success: { dot: 'bg-ok', text: 'text-ok', label: 'success' },
  error: { dot: 'bg-danger', text: 'text-danger', label: 'error' },
  cache_hit: { dot: 'bg-accent', text: 'text-accent', label: 'cache hit' },
};

function StatusPill({ status }: { status: RequestStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[12px] ${s.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/** One labelled row in the request detail dialog. */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5">
      <span className="w-32 flex-none text-[12px] text-faint">{label}</span>
      <span className="min-w-0 flex-1 font-mono text-[12.5px] text-ink">{children}</span>
    </div>
  );
}

/**
 * Paginated gateway request log with status/model filters and a per-row detail
 * dialog. No message bodies are stored (privacy default), so detail is metadata
 * plus the prompt→request→cost lineage pointer.
 */
export function RequestLogTable() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [model, setModel] = useState('');
  const [selected, setSelected] = useState<GatewayRequestItem | null>(null);

  const { data, isLoading, isError } = useGatewayRequests({
    page,
    limit: 20,
    status: status || undefined,
    model: model || undefined,
  });

  const rows = data?.data ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="max-w-[160px]"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="cache_hit">Cache hit</option>
        </Select>
        <Input
          className="max-w-[220px]"
          placeholder="Filter by model…"
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Spinner />
        </div>
      ) : isError ? (
        <Empty title="Couldn't load requests" description="Please try again." />
      ) : rows.length === 0 ? (
        <Empty
          title="No requests logged"
          description="Calls made through the gateway will appear here."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line-soft text-[11px] uppercase tracking-[0.06em] text-faint">
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Tokens</th>
                <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                <th className="px-4 py-2.5 text-right font-medium">Latency</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer border-b border-line-soft bg-surface transition-colors last:border-b-0 hover:bg-elevated"
                >
                  <td className="px-4 py-2.5 text-[12.5px] text-muted" title={dateTime(r.createdAt)}>
                    {timeAgo(r.createdAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono text-[12.5px] text-ink">{r.requestedModel}</span>
                    {r.promptVersionId && (
                      <span
                        className="ml-2 rounded bg-varhi-bg px-1.5 py-0.5 font-mono text-[10.5px] text-varhi"
                        title="Called via a stored prompt (lineage tracked)"
                      >
                        prompt
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusPill status={r.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-muted">
                    {r.promptTokens}→{r.completionTokens}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-ink">
                    {formatUsd(r.costUsd)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[12.5px] text-muted">
                    {formatLatency(r.latencyMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-[13px]">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-muted">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}

      <Dialog
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
        title="Request detail"
        description={selected ? dateTime(selected.createdAt) : ''}
        className="max-w-lg"
      >
        {selected && (
          <div className="divide-y divide-line-soft">
            <DetailRow label="Request ID">
              <span className="flex items-center gap-2">
                <span className="truncate">{selected.id}</span>
                <CopyButton value={selected.id} />
              </span>
            </DetailRow>
            <DetailRow label="Status">
              <StatusPill status={selected.status} />
            </DetailRow>
            <DetailRow label="Provider">{selected.provider ?? '—'}</DetailRow>
            <DetailRow label="Requested">{selected.requestedModel}</DetailRow>
            <DetailRow label="Resolved">{selected.resolvedModel ?? '—'}</DetailRow>
            <DetailRow label="Tokens">
              {selected.promptTokens} prompt → {selected.completionTokens} completion
            </DetailRow>
            <DetailRow label="Cost">{formatUsd(selected.costUsd)}</DetailRow>
            <DetailRow label="Latency">{formatLatency(selected.latencyMs)}</DetailRow>
            <DetailRow label="Cache">{selected.cacheHit ? 'hit' : 'miss'}</DetailRow>
            {selected.errorCode && (
              <DetailRow label="Error">
                <span className="text-danger">{selected.errorCode}</span>
              </DetailRow>
            )}
            {selected.promptVersionId && (
              <DetailRow label="Prompt version">
                <span className="flex items-center gap-2">
                  <span className="truncate text-varhi">{selected.promptVersionId}</span>
                  <CopyButton value={selected.promptVersionId} />
                </span>
              </DetailRow>
            )}
            {selected.virtualKeyId && (
              <DetailRow label="Virtual key">
                <span className="truncate">{selected.virtualKeyId}</span>
              </DetailRow>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
