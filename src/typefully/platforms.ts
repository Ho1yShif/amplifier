import type { Platform } from "./types.js";

/** Display order for platforms in the note, so every note reads the same way. */
export const PLATFORM_ORDER: Platform[] = ["linkedin", "x"];

/** How each platform is named. */
export const PLATFORM_NAMES: Record<Platform, string> = { linkedin: "LinkedIn", x: "X" };

/** The label shown next to a platform's link in the note, e.g. "LinkedIn post". */
export function platformLabel(platform: Platform): string {
  return `${PLATFORM_NAMES[platform]} post`;
}
