/**
 * The label a run report shows for a prompt variant.
 *
 * A baseline cell is labelled by the alias it was resolved from (`production`),
 * which says nothing about *which* version was tested. When the report knows the
 * version number behind the label, an alias reads as "v1 (production)". A label
 * that already is that version ("v2") is left alone.
 *
 * @param variantLabel - The label stored on the run's grid cell.
 * @param versionNumber - The version behind it; null/undefined for runs read
 *   from an older API, optimizer candidates, or a deleted version.
 * @returns The text to show.
 */
export function variantDisplayLabel(variantLabel: string, versionNumber: number | null | undefined): string {
  if (versionNumber == null) return variantLabel;
  const version = `v${versionNumber}`;
  return variantLabel === version ? variantLabel : `${version} (${variantLabel})`;
}
