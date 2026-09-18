import { createHmac } from "node:crypto";
import { isFresh, timingSafeEquals } from "../http/signature.js";
import { nonEmptyString } from "../json.js";
import type { SlackBlock } from "@render-lab/tasks-slack";
import { EDIT_ACTION_ID, REPOST_ACTION_ID } from "../amplifier/template.js";
import { leadOf } from "../amplifier/lead.js";
import {
  decodeMeta,
  EDIT_CALLBACK_ID,
  LEAD_ACTION_ID,
  LEAD_BLOCK_ID,
  type EditMeta,
} from "./editModal.js";

/** Headers Slack signs an interactivity delivery with, lowercased. */
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SIGNATURE_HEADER = "x-slack-signature";

/** The window Slack documents for its own signature check. */
const TOLERANCE_MS = 5 * 60_000;

/**
 * Whether Slack signed this request with SLACK_SIGNING_SECRET.
 *
 * The signature is HMAC-SHA256 over `v0:{timestamp}:{rawBody}`, so the raw body
 * has to be read before anything parses it.
 *
 * A missing secret returns false, so an unconfigured receiver rejects every
 * request instead of answering 500 to all of them.
 */
export function verifySlackSignature(
  headers: Record<string, string>,
  rawBody: string,
  secret: string | undefined,
  nowMs: number,
): boolean {
  if (!secret) {
    console.error("[amplifier] SLACK_SIGNING_SECRET is unset, so every Slack request is rejected.");
    return false;
  }
  const timestamp = headers[TIMESTAMP_HEADER];
  const signature = headers[SIGNATURE_HEADER];
  if (timestamp === undefined || signature === undefined) return false;

  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  if (!timingSafeEquals(`v0=${digest}`, signature)) return false;
  return isFresh("Slack", timestamp, nowMs, TOLERANCE_MS);
}

/** What a Repost click tells the receiver. */
export interface RepostClick {
  /** Channel the clicked note is in. */
  channel: string;
  /** The `ts` of the note the click is about, which is the thread's parent. */
  messageTs: string;
  /** Slack id of the person who clicked. */
  userId: string;
  /** Key Value key of the stored note, carried in the button's `value`. */
  noteKey: string;
  /** Slack URL for posting an ephemeral answer back to the clicker. */
  responseUrl: string;
}

/**
 * Read a Repost click out of an interactivity payload, or null.
 *
 * Anything whose first action is not the Repost button maps to null, so another
 * interactive element added to the app later does not start a repost.
 *
 * `messageTs` is the clicked message's `thread_ts`, falling back to its own
 * `ts`. The repost reminder is a reply carrying its own Repost button, and a
 * click on it is about the note at the top of the thread: that is the message
 * the reaction, the "Reposted by" reply and the reposted marker belong on.
 */
export function parseRepostClick(payload: unknown): RepostClick | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const actions = Array.isArray(p["actions"]) ? p["actions"] : [];
  const action = actions[0] as Record<string, unknown> | undefined;
  if (!action || action["action_id"] !== REPOST_ACTION_ID) return null;

  const channel = nonEmptyString((p["channel"] as Record<string, unknown> | undefined)?.["id"]);
  const message = p["message"] as Record<string, unknown> | undefined;
  const messageTs = nonEmptyString(message?.["thread_ts"]) ?? nonEmptyString(message?.["ts"]);
  const userId = nonEmptyString((p["user"] as Record<string, unknown> | undefined)?.["id"]);
  const noteKey = nonEmptyString(action["value"]);
  const responseUrl = nonEmptyString(p["response_url"]);
  if (!channel || !messageTs || !userId || !noteKey || !responseUrl) {
    console.error("[amplifier] A Repost click was missing fields the repost task needs.");
    return null;
  }
  return { channel, messageTs, userId, noteKey, responseUrl };
}

/** What an Edit click tells the receiver. */
export interface EditClick {
  channel: string;
  /** The note's `ts`, which is the message the button is in. */
  messageTs: string;
  /** Key Value key of the stored note, carried in the button's `value`. */
  noteKey: string;
  /** Slack's one-shot ticket for opening a modal, good for three seconds. */
  triggerId: string;
  /** Slack URL for answering the editor privately, kept for after the submit. */
  responseUrl: string;
  /** The note's current lead line, which the modal opens prefilled with. */
  lead: string;
}

/**
 * Read an Edit click out of an interactivity payload, or null.
 *
 * The button rides in the note's own actions block, so the clicked message is
 * the note: no thread walk, and no check that the click came from the queue
 * channel, because no other message carries the button.
 *
 * The prefill falls back to the message's `text`, which `renderParent` sets to
 * the lead line. A note whose blocks cannot be read still opens an editable
 * modal rather than a dead button.
 */
export function parseEditClick(payload: unknown): EditClick | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const actions = Array.isArray(p["actions"]) ? p["actions"] : [];
  const action = actions[0] as Record<string, unknown> | undefined;
  if (!action || action["action_id"] !== EDIT_ACTION_ID) return null;

  const channel = nonEmptyString((p["channel"] as Record<string, unknown> | undefined)?.["id"]);
  const message = p["message"] as Record<string, unknown> | undefined;
  const messageTs = nonEmptyString(message?.["ts"]);
  const noteKey = nonEmptyString(action["value"]);
  const triggerId = nonEmptyString(p["trigger_id"]);
  const responseUrl = nonEmptyString(p["response_url"]);
  if (!channel || !messageTs || !noteKey || !triggerId || !responseUrl) {
    console.error("[amplifier] An Edit click was missing fields the modal needs.");
    return null;
  }

  const text = nonEmptyString(message?.["text"]) ?? "";
  const blocks = (Array.isArray(message?.["blocks"]) ? message["blocks"] : []) as SlackBlock[];
  const lead = leadOf({ text, blocks }) ?? text;

  return { channel, messageTs, noteKey, triggerId, responseUrl, lead };
}

/** A submitted edit modal. */
export interface EditSubmit {
  meta: EditMeta;
  /** Exactly what was typed. The receiver trims it and rejects a blank. */
  lead: string;
}

/**
 * Read a submitted edit modal, or null when the payload is not one.
 *
 * The note comes out of `private_metadata` and not out of a lookup, so a
 * submission needs no state kept since the modal opened.
 */
export function parseEditSubmit(payload: unknown): EditSubmit | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (p["type"] !== "view_submission") return null;

  const view = p["view"] as Record<string, unknown> | undefined;
  if (view?.["callback_id"] !== EDIT_CALLBACK_ID) return null;

  const meta = decodeMeta(view["private_metadata"]);
  if (!meta) {
    console.error("[amplifier] An edit submission named no note amplifier could edit.");
    return null;
  }

  const values = (view["state"] as Record<string, unknown> | undefined)?.["values"] as
    Record<string, Record<string, { value?: unknown }>> | undefined;
  const lead = values?.[LEAD_BLOCK_ID]?.[LEAD_ACTION_ID]?.value;
  return { meta, lead: typeof lead === "string" ? lead : "" };
}
