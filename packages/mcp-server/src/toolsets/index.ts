import type { McpServerConfig } from '../config';
import { catalogTools } from './catalog';
import { evaluationTools } from './evaluations';
import { gatewayTools } from './gateway';
import { promptTools } from './prompts';
import { traceTools } from './traces';
import type { AnyToolDefinition } from './types';

export type { AnyToolDefinition, ToolContext } from './types';
export { defineTool } from './types';

/**
 * Every tool this server can register, in the order toolsets appear to a client.
 *
 * Order is deliberate rather than alphabetical: prompts first because that is the
 * product's centre of gravity, then the things that run (gateway, tools), then the
 * things that observe (traces, evaluations).
 */
export const ALL_TOOLS: AnyToolDefinition[] = [
  ...promptTools,
  ...gatewayTools,
  ...catalogTools,
  ...traceTools,
  ...evaluationTools,
];

/**
 * Selects the tools a given configuration should expose.
 *
 * Read-only mode *removes* mutating tools rather than refusing them at call time. A tool
 * that is absent from `tools/list` cannot be chosen by mistake, cannot be argued with,
 * and does not need the model to have read a warning in its description — which is the
 * whole point of handing an agent a read-only key in the first place.
 *
 * @param config - Resolved server configuration.
 * @returns The tools to register, in {@link ALL_TOOLS} order.
 */
export function selectTools(config: McpServerConfig): AnyToolDefinition[] {
  return ALL_TOOLS.filter(
    (tool) =>
      config.toolsets.includes(tool.toolset) && (!config.readOnly || tool.readOnlyHint),
  );
}
