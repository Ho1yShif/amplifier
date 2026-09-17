/** Join the non-empty parts of a message the way Slack renders paragraphs. */
export function body(parts: string[]): string {
  return parts.filter((s) => s !== "").join("\n\n");
}
