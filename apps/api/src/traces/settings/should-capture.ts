/**
 * Resolves whether request/response payloads should be captured for a call
 * (FAQ Q5). A per-request override always wins over the team default.
 *
 * @param teamSetting - The team's `capture_payloads` default (absent row → true).
 * @param perRequestOverride - Optional per-call override (`x-capture-payloads`
 *   header or body `trace.capturePayloads`); when omitted, the team default applies.
 * @returns True when a `span_payloads` row should be written for this call.
 */
export function shouldCapture(teamSetting: boolean, perRequestOverride?: boolean): boolean {
  return perRequestOverride ?? teamSetting;
}
