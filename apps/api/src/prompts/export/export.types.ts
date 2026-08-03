/**
 * The portable export format for a single prompt version.
 * `schemaVersion` is always `1` in Phase 1.
 * Import endpoint rejects any file where `schemaVersion !== 1`.
 */
export interface ExportFile {
  schemaVersion: 1;
  exportedAt:    string;
  prompt: {
    name:        string;
    description: string | null;
  };
  version: {
    versionNumber: number;
    messages:      Array<{ role: string; content: string }>;
    variables:     string[];
    createdAt:     string;
  };
}
