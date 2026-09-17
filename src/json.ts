// Readers for values that came out of somebody else's JSON, where a field can
// be absent, null, or the wrong type.

/**
 * A value when it is a non-empty string, else undefined.
 *
 * An empty string reads as absent. Typefully and Slack both send "" for a field
 * they have no value for, and every caller here treats that the same as a
 * missing field.
 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
