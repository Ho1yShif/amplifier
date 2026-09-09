import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The prompt file, relative to this module. `../../prompts/` resolves to the
 * repo root from both `src/summary/` and `dist/summary/`, so tsc needs no step
 * to copy the file into the build.
 */
const PROMPT_URL = new URL("../../prompts/post-summary.md", import.meta.url);

let cached: string | undefined;

/** The summary prompt, read once per process. */
export function loadPrompt(): string {
  return (cached ??= readFileSync(fileURLToPath(PROMPT_URL), "utf8"));
}

/** Drop the cached prompt. For tests. */
export function clearPromptCache(): void {
  cached = undefined;
}
