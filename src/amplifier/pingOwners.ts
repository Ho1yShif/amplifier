import { randomUUID } from "node:crypto";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { deleteKeys, get as kvGet, lock, set as kvSet } from "@render-lab/tasks-render-kv";
import { loadConfig, type AmplifierConfig } from "../config.js";
import { getPage } from "../notion/getPage.js";
import { readLaunch } from "../notion/launch.js";
import { isLaunch, type Launch, type Owner } from "../notion/types.js";
import { isResolved, lookupUser, openDm } from "../slack/lookupUser.js";
import { postNote } from "../slack/postNote.js";
import { pingedKey, pingInflightKey, releasePing } from "./pinged.js";
import {
  ownerLabel,
  renderPingDm,
  renderUnreachableNote,
  type UnreachableOwner,
} from "./pingTemplate.js";
import { INFLIGHT_TTL_SECONDS } from "./seen.js";

export interface PingOwnersInput {
  /** Notion page id from the webhook, or pasted in for a manual run. */
  pageId: string;
  /** Ping a page the marker already records. Re-sends the DMs. */
  force?: boolean;
  dryRun?: boolean;
  /** Channel the unreachable-owner note goes to. Defaults to SLACK_CHANNEL. */
  slackChannel?: string;
}

/** One owner the run DM'd. */
export interface PingedOwner {
  name?: string;
  email?: string;
  /** false in dry run, and false when the Slack port reported no delivery. */
  delivered: boolean;
}

export interface PingOwnersResult {
  pageId: string;
  dryRun: boolean;
  /** Set when no DM was sent, naming why. */
  skipped?: "no-url" | "no-owners" | "other-database" | "pinged" | "claimed";
  /** One entry per owner a DM was addressed to. */
  pinged?: PingedOwner[];
  /** Owners with no DM, and why. Named in the channel note. */
  unreachable?: UnreachableOwner[];
}

/**
 * DM one owner, or say why not.
 *
 * Email, then Slack user id, then DM channel, then the message. Every step can
 * answer "no" about this one person without ending the run, because the other
 * owners' DMs have already gone out or are still to go.
 */
async function pingOwner(
  ctx: TaskContext,
  launch: Launch,
  owner: Owner,
  config: AmplifierConfig,
): Promise<PingedOwner | UnreachableOwner> {
  const email = owner.email?.trim();
  if (!email) {
    return {
      owner,
      reason:
        "the Notion page carries no email for them, which is also what a Notion " +
        "integration without the user-email capability looks like",
    };
  }

  const found = await ctx.run(lookupUser, { email });
  if (!isResolved(found)) {
    return { owner, reason: `Slack answered \`${found.error}\` for ${email}` };
  }

  const dm = await ctx.run(openDm, { userId: found.userId });
  if (!isResolved(dm)) {
    return { owner, reason: `Slack answered \`${dm.error}\` opening a DM with ${email}` };
  }

  const message = renderPingDm(launch, { channel: dm.channelId, ask: config.pingAsk });
  if (config.dryRun) {
    console.log(`[dry run] would DM ${ownerLabel(owner)}:\n${message.markdown}`);
    return { ...(owner.name ? { name: owner.name } : {}), email, delivered: false };
  }

  try {
    const posted = await ctx.run(postNote, message);
    return {
      ...(owner.name ? { name: owner.name } : {}),
      email,
      delivered: posted.delivered,
    };
  } catch (err) {
    // The DM is already past SLACK_RETRY, so this is a lasting failure for one
    // person. Reported in the channel rather than thrown, so the owners who
    // did get a DM are not DM'd twice by the next delivery.
    const detail = err instanceof Error ? err.message : String(err);
    return { owner, reason: `the DM to ${email} failed: ${detail}` };
  }
}

/** Whether `pingOwner` sent, or tried to send, a DM. */
function isPinged(outcome: PingedOwner | UnreachableOwner): outcome is PingedOwner {
  return !("reason" in outcome);
}

/**
 * Post the note naming owners nobody could DM.
 *
 * Returns whether Slack accepted it, because the marker is written once
 * anything reached Slack. A failure is logged rather than thrown: the DMs that
 * did go out are the run's real work.
 */
async function postUnreachable(
  ctx: TaskContext,
  launch: Launch,
  unreachable: UnreachableOwner[],
  config: AmplifierConfig,
): Promise<boolean> {
  const channel = config.slackChannel;
  if (!channel) {
    console.error(
      `[amplifier] No SLACK_CHANNEL, so nobody hears that ${unreachable.length} owner(s) of ` +
        `page ${launch.pageId} got no DM: ${unreachable.map((u) => u.reason).join("; ")}`,
    );
    return false;
  }

  const note = renderUnreachableNote(launch, unreachable, { channel });
  if (config.dryRun) {
    console.log(`[dry run] would post:\n${note.markdown}`);
    return false;
  }

  try {
    const posted = await ctx.run(postNote, note);
    return posted.delivered;
  } catch (err) {
    console.error(
      `[amplifier] Could not post the unreachable-owner note for page ${launch.pageId}.`,
      err,
    );
    return false;
  }
}

/** Raw implementation of amplifier.pingOwners. */
export async function pingOwnersImpl(
  ctx: TaskContext,
  input: PingOwnersInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PingOwnersResult> {
  const pageId = input.pageId?.trim();
  if (!pageId) {
    throw new Error("Pass the Notion page id as pageId.");
  }

  const config = loadConfig(
    {
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.slackChannel !== undefined ? { slackChannel: input.slackChannel } : {}),
    },
    env,
  );

  // Marker, then lock, then the work, then the marker again — the order
  // `announceGroups` uses. It matters more here: a property edit is something
  // people do repeatedly, and Notion retries a failed delivery for about 24
  // hours, so this task is re-entered far more often than the announce path.
  const marker = pingedKey(pageId);
  const { value } = await ctx.run(kvGet, { key: marker });
  if (value !== null) {
    if (!input.force) {
      console.log(
        `[amplifier] Page ${pageId} was already pinged. Pass force: true to DM its owners again.`,
      );
      return { pageId, dryRun: config.dryRun, skipped: "pinged" };
    }
    await ctx.run(deleteKeys, { keys: [marker] });
    console.log(`[amplifier] Cleared the pinged marker for page ${pageId}.`);
  }

  const lockKey = pingInflightKey(pageId);
  const token = `amplifier:run:${randomUUID()}`;
  const { acquired } = await ctx.run(lock, {
    key: lockKey,
    token,
    ttlSeconds: INFLIGHT_TTL_SECONDS,
  });
  if (!acquired) {
    // Another delivery of the same property edit is pinging this page now.
    return { pageId, dryRun: config.dryRun, skipped: "claimed" };
  }

  try {
    const { page } = await ctx.run(getPage, { pageId });
    const outcome = readLaunch(page, {
      typefullyProperty: config.notionTypefullyProperty,
      ownersProperty: config.notionOwnersProperty,
      ...(config.notionDatabaseId ? { databaseId: config.notionDatabaseId } : {}),
    });
    if (!isLaunch(outcome)) {
      console.log(`[amplifier] Page ${pageId} is not ready to ping: ${outcome.skip}.`);
      return { pageId, dryRun: config.dryRun, skipped: outcome.skip };
    }

    const pinged: PingedOwner[] = [];
    const unreachable: UnreachableOwner[] = [];
    // Sequential, so the owners are DM'd in the order the property lists them
    // and one slow lookup cannot open every DM at once.
    for (const owner of outcome.owners) {
      const result = await pingOwner(ctx, outcome, owner, config);
      if (isPinged(result)) pinged.push(result);
      else unreachable.push(result);
    }

    let accepted = pinged.some((p) => p.delivered);
    if (unreachable.length > 0) {
      const posted = await postUnreachable(ctx, outcome, unreachable, config);
      accepted = accepted || posted;
    }
    // Only after Slack accepted something. The marker is separate from the
    // lock, so a lock left behind by a crashed run never reads as a ping that
    // went out.
    if (accepted) {
      await ctx.run(kvSet, { key: marker, value: "pinged", ttlSeconds: config.seenTtlSeconds });
    }

    return {
      pageId,
      dryRun: config.dryRun,
      pinged,
      ...(unreachable.length > 0 ? { unreachable } : {}),
    };
  } finally {
    await releasePing(ctx, lockKey, token);
  }
}

/**
 * DM a launch's owners that it is time to amplify.
 *
 * No retry policy, matching `amplifier.announcePost`. A DM that failed to send
 * is better re-run by hand than re-sent on a schedule, and the Notion delivery
 * retries on its own.
 */
export const pingOwners = task({ name: "amplifier.pingOwners" }, pingOwnersImpl);
