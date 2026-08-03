import { ToolAnalyticsPanel } from './ToolAnalyticsPanel';

/**
 * `/gateway/tools/analytics` — thin page shell around {@link ToolAnalyticsPanel}.
 * Read-only, stretch-only (TC7): no tool list or CRUD here, that lives on the
 * separate Tool Catalog page (TC5, still unmerged as of this task).
 */
export function ToolAnalyticsPage() {
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Tool analytics</h1>
        <p className="mt-1 text-[13px] text-muted">
          Call volume, error rate, and latency per tool, aggregated from traced tool executions.
        </p>
      </header>
      <ToolAnalyticsPanel />
    </div>
  );
}
