import type { RenderResult, ToolDefinition } from './types';

/** Input accepted by {@link withToolOverride} — just the two `render()` fields it reads. */
export interface ToolOverrideSource {
  tools: ToolDefinition[];
  toolResolutions: RenderResult['toolResolutions'];
}

/** What {@link withToolOverride} hands back — drop straight into `gateway.chat()`. */
export interface ToolOverrideResult {
  tools: ToolDefinition[];
  toolRefs: { name: string; alias: string }[];
}

/**
 * Overrides one tool's resolution for a single `gateway.chat()` call, without
 * touching the prompt's own binding.
 *
 * Sending the same tool name in both `tools` and `toolRefs` is a 400 from the
 * gateway (two definitions, no tie-breaker) — this removes the tool from `tools`
 * first, then adds it to `toolRefs` under the alias you asked for. If the tool was
 * already bound, it warns rather than silently swapping it, naming whatever the
 * prompt currently has configured (from `render()`'s `toolResolutions`) so the
 * override doesn't read as the prompt's own setting.
 *
 * This only affects this one call — the prompt's binding (its default, or the row
 * this prompt alias owns) is unchanged either way. To change it for good, use
 * `prompts.setToolBinding` / `prompts.setAliasToolBinding`.
 *
 * @param rendered - The `tools` and `toolResolutions` from `prompts.render(...)`.
 * @param override - The tool name to override, and the tool alias to use instead.
 * @returns `tools` with the overridden name removed, and a `toolRefs` entry for it —
 *   spread both into the same `gateway.chat()` call.
 */
export function withToolOverride(
  rendered: ToolOverrideSource,
  override: { name: string; alias: string },
): ToolOverrideResult {
  const resolution = rendered.toolResolutions.find((r) => r.name === override.name);

  if (resolution) {
    const current = resolution.alias ?? (resolution.pinnedVersionNumber ? `pinned to v${resolution.pinnedVersionNumber}` : 'unknown');
    // Naming the layer matters when it is the prompt's default: that binding is shared
    // by every alias inheriting it, so changing it there is not a local edit.
    const via = resolution.source === 'default' ? " (the prompt's default binding)" : ' (this prompt alias\'s own binding)';
    console.warn(
      `[acruxcore] Overriding "${override.name}" to alias "${override.alias}" for this call. ` +
        `The prompt currently has this tool set to "${current}"${via} — ` +
        `that setting is unchanged. If this override should be permanent, change it there instead.`,
    );
  }

  return {
    tools: rendered.tools.filter((t) => t.function.name !== override.name),
    toolRefs: [{ name: override.name, alias: override.alias }],
  };
}
