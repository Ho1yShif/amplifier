import type { PostMessageInput } from "@render-lab/tasks-slack";
import { compareTime } from "../time.js";
import type { Platform, PlatformLink } from "../typefully/types.js";
import type { PostGroup } from "./group.js";

/** The note's opening line and the amplify ask. Override with AMPLIFIER_CALL_TO_ACTION. */
export const DEFAULT_CALL_TO_ACTION =
  "New Render social post! Please like and share when you have a minute";

/** Display order in the note, so every note reads the same way. */
const PLATFORM_ORDER: Platform[] = ["linkedin", "x"];

const PLATFORM_LABELS: Record<Platform, string> = { x: "X post", linkedin: "LinkedIn post" };

export interface RenderNoteOptions {
  /** Slack channel to post to. Requires SLACK_BOT_TOKEN to be honored. */
  channel?: string;
  callToAction?: string;
}

/** One link per platform in display order, keeping the earliest of any duplicates. */
function orderedLinks(group: PostGroup): PlatformLink[] {
  const byPlatform = new Map<Platform, PlatformLink>();
  for (const link of group.links) {
    const seen = byPlatform.get(link.platform);
    if (!seen || compareTime(link.publishedAt, seen.publishedAt) < 0) {
      byPlatform.set(link.platform, link);
    }
  }
  return PLATFORM_ORDER.flatMap((p) => {
    const link = byPlatform.get(p);
    return link ? [link] : [];
  });
}

/** Platforms this note covers, in display order. */
export function notePlatforms(group: PostGroup): Platform[] {
  return orderedLinks(group).map((l) => l.platform);
}

function linkMrkdwn(link: PlatformLink, shareUrl: string | undefined): string {
  const label = PLATFORM_LABELS[link.platform];
  if (link.url) return `<${link.url}|${label}>`;
  if (shareUrl) return `<${shareUrl}|${label} (Typefully draft)>`;
  return `${label} (link pending)`;
}

/**
 * Build the Slack message for one announcement: the amplify ask, the post text
 * as a quote, and a bulleted link per platform.
 *
 * `text` is the notification fallback Slack shows in the sidebar and in push
 * notifications, so it carries the URLs rather than only the ask.
 */
export function renderNote(group: PostGroup, opts: RenderNoteOptions = {}): PostMessageInput {
  const links = orderedLinks(group);
  // Slack mrkdwn has no list syntax, so the bullet is a literal character.
  const linkList = links.map((l) => `• ${linkMrkdwn(l, group.shareUrl)}`).join("\n");
  const quotes = group.previews
    .filter((p) => p !== "")
    .map((p) => `> ${p}`)
    .join("\n>\n");
  const callToAction = opts.callToAction ?? DEFAULT_CALL_TO_ACTION;

  const markdown = [callToAction, quotes, linkList].filter((s) => s !== "").join("\n\n");
  const urls = links.map((l) => l.url).filter((u): u is string => u !== undefined);
  const target = urls.length > 0 ? urls.join(" ") : (group.shareUrl ?? "link pending");
  const text = `${callToAction} ${target}`;

  return {
    text,
    markdown,
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
}
