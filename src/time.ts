// Timestamp ordering. Typefully's timestamps are strings, and string order only
// matches time order when every timestamp uses the same UTC format. Compare
// parsed milliseconds instead, and keep the string for display.

/**
 * Milliseconds for an ISO 8601 timestamp. An unparseable value compares greater
 * than every real timestamp, so it goes last in an oldest-first sort and first
 * in a newest-first one.
 */
export function timeMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Comparator that orders ISO timestamps oldest first. */
export function compareTime(a: string, b: string): number {
  const x = timeMs(a);
  const y = timeMs(b);
  if (x === y) return 0;
  return x < y ? -1 : 1;
}
