import type { Prompt, PromptExport } from './types';
import { api } from './client';

/** Fetch a single version as portable export JSON (round-trips with import). */
export function exportVersion(
  promptId: string,
  versionNumber: number,
): Promise<PromptExport> {
  return api<PromptExport>(`/prompts/${promptId}/versions/${versionNumber}/export`);
}

/**
 * Import export JSON, always creating a new prompt + first version.
 *
 * @param payload - A previously exported prompt version.
 * @returns The newly created prompt.
 */
export function importPrompt(payload: PromptExport): Promise<Prompt> {
  return api<Prompt>('/prompts/import', { method: 'POST', body: payload });
}

/**
 * Trigger a browser download of arbitrary JSON.
 *
 * @param filename - Suggested file name.
 * @param data - Any JSON-serializable value.
 */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
