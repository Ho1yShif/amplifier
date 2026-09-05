import type { PostMessageInput } from "@render-lab/tasks-slack";
import type { Platform, PlatformLink } from "../typefully/types.js";
import type { PostGroup } from "./group.js";

/** What the note asks the team to do. Override with AMPLIFIER_CALL_TO_ACTION. */
export const DEFAULT_CALL_TO_ACTION = "Give it a like and a repost when you get a minute.";

const NOTE_TITLE = "New Render post to amplify";

/** Display order in the note, so every note reads the same way. */
const PLATFORM_ORDER: Platform[] = ["x", "linkedin"];

const PLATFORM_LABELS: Record<Platform, string> = { x: "X", linkedin: "LinkedIn" };

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
    if (!seen || link.publishedAt.localeCompare(seen.publishedAt) < 0) {
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
 * Build the Slack message for one announcement: the post text as a quote, a
 * link per platform, and the amplify ask.
 *
 * `text` is the notification fallback Slack shows in the sidebar and in push
 * notifications, so it carries the URLs rather than only the title.
 */
export function renderNote(group: PostGroup, opts: RenderNoteOptions = {}): PostMessageInput {
  const links = orderedLinks(group);
  const linkLine = links.map((l) => linkMrkdwn(l, group.shareUrl)).join("  ·  ");
  const quotes = group.previews.filter((p) => p !== "").map((p) => `> ${p}`).join("\n>\n");
  const callToAction = opts.callToAction ?? DEFAULT_CALL_TO_ACTION;

  const markdown = [quotes, linkLine, callToAction].filter((s) => s !== "").join("\n\n");
  const urls = links.map((l) => l.url).filter((u): u is string => u !== undefined);
  const text = `${NOTE_TITLE}: ${urls.length > 0 ? urls.join(" ") : (group.shareUrl ?? "link pending")}`;

  return {
    text,
    title: NOTE_TITLE,
    markdown,
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
}
