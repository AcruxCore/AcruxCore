import type { GatewayMeta } from '@/api';
import { formatLatency, formatUsd } from './format';

export type TelemetryState = 'idle' | 'running' | 'done' | 'error';

export interface TelemetryProps {
  state: TelemetryState;
  meta: GatewayMeta | null;
  latencyMs: number | null;
  usage: { prompt: number; completion: number } | null;
}

interface Gauge {
  label: string;
  value: string;
  /** Semantic tint for the value text. */
  tone?: 'ink' | 'accent' | 'ok' | 'danger' | 'muted';
}

const TONE_CLASS: Record<NonNullable<Gauge['tone']>, string> = {
  ink: 'text-ink',
  accent: 'text-accent',
  ok: 'text-ok',
  danger: 'text-danger',
  muted: 'text-faint',
};

/**
 * The gateway telemetry readout — the signature element. When a completion
 * returns, the strip of monospace gauges lights up with what the gateway
 * actually did: which provider it routed to, the resolved model, the priced
 * cost, cache result, latency, and token accounting. This makes the gateway's
 * otherwise-invisible work legible at a glance.
 */
export function Telemetry({ state, meta, latencyMs, usage }: TelemetryProps) {
  const idle = state === 'idle';
  const dash = '—';

  const cacheTone: Gauge['tone'] =
    meta?.cache === 'hit' ? 'accent' : meta?.cache === 'miss' ? 'muted' : 'muted';

  // The cost header is a raw numeric string (e.g. "0.0000032999999999997"); parse
  // and format it so the readout shows a clean priced value, not a float artifact.
  const costNum = meta?.costUsd != null ? Number(meta.costUsd) : null;
  const costValue =
    costNum != null && Number.isFinite(costNum)
      ? formatUsd(costNum)
      : state === 'done'
        ? '—'
        : dash;

  const gauges: Gauge[] = [
    { label: 'Provider', value: meta?.provider ?? dash, tone: meta?.provider ? 'ink' : 'muted' },
    { label: 'Model', value: meta?.model ?? dash, tone: meta?.model ? 'ink' : 'muted' },
    {
      label: 'Cost',
      value: costValue,
      tone: costNum && costNum > 0 ? 'accent' : 'muted',
    },
    { label: 'Cache', value: meta?.cache ?? dash, tone: cacheTone },
    {
      label: 'Latency',
      value: latencyMs != null ? formatLatency(latencyMs) : dash,
      tone: latencyMs != null ? 'ink' : 'muted',
    },
    {
      label: 'Tokens',
      value: usage ? `${usage.prompt}→${usage.completion}` : dash,
      tone: usage ? 'ink' : 'muted',
    },
  ];

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2.5">
        <span
          className={[
            'h-1.5 w-1.5 rounded-full transition-colors',
            state === 'running'
              ? 'animate-pulse bg-accent shadow-[0_0_8px_var(--accent-dim)]'
              : state === 'done'
                ? 'bg-accent shadow-[0_0_8px_var(--accent-dim)]'
                : state === 'error'
                  ? 'bg-danger'
                  : 'bg-faint',
          ].join(' ')}
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-faint">
          Gateway telemetry
        </span>
        {meta?.requestId && (
          <span className="ml-auto truncate font-mono text-[11px] text-faint" title={meta.requestId}>
            {meta.requestId}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 divide-line-soft sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
        {gauges.map((g) => (
          <div key={g.label} className="px-4 py-3">
            <p className="text-[10.5px] uppercase tracking-[0.08em] text-faint">{g.label}</p>
            <p
              className={[
                'mt-1 truncate font-mono text-[13px] transition-colors',
                idle ? 'text-faint' : TONE_CLASS[g.tone ?? 'ink'],
              ].join(' ')}
              title={g.value}
            >
              {g.value}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
