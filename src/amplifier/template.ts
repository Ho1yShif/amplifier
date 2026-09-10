import type { PostMessageInput } from "@render-lab/tasks-slack";
import { compareTime } from "../time.js";
import { PLATFORM_ORDER, platformLabel } from "../typefully/platforms.js";
import type { Platform, PlatformLink } from "../typefully/types.js";
import type { PostGroup } from "./group.js";

/** The note's opening line and the amplify ask. Override with AMPLIFIER_CALL_TO_ACTION. */
export const DEFAULT_CALL_TO_ACTION =
  "New Render social post! Please like and share when you have a minute";

export interface RenderNoteOptions {
  /** Slack channel to post to. Requires SLACK_BOT_TOKEN to be honored. */
  channel?: string;
  callToAction?: string;
  /** The model's one-line summary. When present it is the note's whole lead line. */
  summary?: string;
  /** Why there is no summary, shown under the fallback lead line. */
  summaryError?: string;
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
  const label = platformLabel(link.platform);
  if (link.url) return `<${link.url}|${label}>`;
  if (shareUrl) return `<${shareUrl}|${label} (Typefully draft)>`;
  return `${label} (link pending)`;
}

/**
 * Build the Slack message for one announcement.
 *
 * With a summary, the note is that one line and a link per platform. The links
 * are bulleted only when there are two, because one link is not a list.
 * Without one, it falls back to the call to action, the reason the summary is
 * missing, and the draft's preview as a quote — the preview is the only content
 * signal left, so it is worth the extra lines.
 *
 * `text` is the notification fallback Slack shows in the sidebar and in push
 * notifications. It carries the lead line and no URL: every link in the note is
 * hyperlinked on its label, and a bare URL here also renders an unfurl card.
 */
export function renderNote(group: PostGroup, opts: RenderNoteOptions = {}): PostMessageInput {
  const links = orderedLinks(group);
  // Slack mrkdwn has no list syntax, so the bullet is a literal character. One
  // link needs no list, so it goes in on its own.
  const bullet = links.length > 1 ? "• " : "";
  const linkList = links.map((l) => `${bullet}${linkMrkdwn(l, group.shareUrl)}`).join("\n");
  const summary = opts.summary?.trim();
  const lead = summary || opts.callToAction?.trim() || DEFAULT_CALL_TO_ACTION;

  const blocks: string[] = [];
  if (summary) {
    blocks.push(lead);
  } else {
    const failure = opts.summaryError
      ? `\n_(Summarization LLM call failed: ${opts.summaryError})_`
      : "";
    blocks.push(`${lead}${failure}`);
    const quotes = group.previews
      .filter((p) => p !== "")
      .map((p) => `> ${p}`)
      .join("\n>\n");
    blocks.push(quotes);
  }
  blocks.push(linkList);

  return {
    text: lead,
    markdown: blocks.filter((s) => s !== "").join("\n\n"),
    ...(opts.channel ? { channel: opts.channel } : {}),
  };
}
