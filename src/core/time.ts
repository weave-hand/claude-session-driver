/** A second-precision UTC ISO-8601 timestamp, e.g. `2026-06-13T13:40:27Z`. */
export function isoSecondsUtc(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
