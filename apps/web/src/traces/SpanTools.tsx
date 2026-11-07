import { MonoBlock } from '@/ui';
import { Collapsible } from './Collapsible';
import { formatPayload } from './format';

export interface SpanToolsProps {
  /** `payload.tools` (from `toolSets`): an OpenAI-style tools array, or anything older/odd. */
  tools: unknown;
  /** `payload.toolChoice` as stored, e.g. `"auto"` or a forced function. */
  toolChoice: unknown;
}

/** The readable part of one OpenAI-style tool definition. */
interface ToolSummary {
  name: string;
  description?: string;
}

/**
 * Pulls `name` + `description` out of each tool. A definition in a shape this build does
 * not recognise still counts, under a placeholder name, so the count never under-reports
 * what the model was offered.
 */
function summarize(tools: unknown[]): ToolSummary[] {
  return tools.map((t, i) => {
    const fn = (t as { function?: { name?: unknown; description?: unknown } } | null)?.function;
    const name = typeof fn?.name === 'string' ? fn.name : `tool ${i + 1}`;
    const description = typeof fn?.description === 'string' ? fn.description : undefined;
    return { name, description };
  });
}

/** `"auto"` stays as is; a forced function reads as its name. */
function choiceLabel(choice: unknown): string | null {
  if (choice == null) return null;
  if (typeof choice === 'string') return choice;
  const name = (choice as { function?: { name?: unknown } }).function?.name;
  return typeof name === 'string' ? `forced: ${name}` : JSON.stringify(choice);
}

/**
 * The tool definitions a gateway `llm` call sent the model (issues #792, #793): which
 * tools it could pick from, and the description and schema it read for each. This is the
 * first thing to check when a model picks the wrong tool, so names and descriptions are
 * listed in plain text and the full JSON sits one click away.
 *
 * Renders nothing for a span whose call sent neither tools nor a `tool_choice`. A call that
 * sent only a `tool_choice` (`"none"` with an empty list, say) still shows it, since a
 * forced or disabled choice explains what the model did.
 */
export function SpanTools({ tools, toolChoice }: SpanToolsProps) {
  const list = Array.isArray(tools) ? tools : [];
  const choice = choiceLabel(toolChoice);
  if (list.length === 0 && !choice) return null;
  const rows = summarize(list);

  return (
    <section className="rounded-lg border border-line-soft bg-surface px-3 py-2" data-testid="span-tools">
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-faint">
          Tools sent to the model ({rows.length})
        </span>
        {choice && (
          <span className="font-mono text-[11.5px] text-muted" data-testid="span-tool-choice">
            tool_choice: {choice}
          </span>
        )}
      </div>
      {rows.map((row, i) => (
        <div key={`${row.name}-${i}`} className="border-b border-line-soft py-1 text-[13px] last:border-0">
          <span className="font-mono text-ink">{row.name}</span>
          {row.description && <div className="mt-0.5 text-[12px] leading-snug text-muted">{row.description}</div>}
        </div>
      ))}
      {rows.length > 0 && (
        <div className="mt-1.5">
          <Collapsible label="Full definitions (JSON)" testId="span-tools-json-toggle">
            <MonoBlock value={formatPayload(list)} />
          </Collapsible>
        </div>
      )}
    </section>
  );
}
