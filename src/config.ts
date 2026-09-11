import { MAX_SETTLE_MINUTES } from "./amplifier/retry.js";
import { DEFAULT_CALL_TO_ACTION } from "./amplifier/template.js";
import { DEFAULT_SUMMARY_MODEL } from "./summary/model.js";

/** Overrides accepted per run; anything omitted falls back to env, then defaults. */
export interface CheckPostsInput {
  socialSetId?: string;
  limit?: number;
  lookbackMinutes?: number;
  groupWindowMinutes?: number;
  settleMinutes?: number;
  seenTtlDays?: number;
  slackChannel?: string;
  callToAction?: string;
  /** Provider-prefixed model id for the summary, e.g. "anthropic/claude-sonnet-5". */
  summaryModel?: string;
  dryRun?: boolean;
  /** ISO 8601 "now", for tests and for replaying a past window. */
  now?: string;
  /** ISO 8601 time the webhook event was received. Absent means do not settle. */
  eventAt?: string;
  /** Typefully draft the event was about. Absent means do not settle. */
  draftId?: string;
}

export interface AmplifierConfig {
  socialSetId?: string;
  limit: number;
  lookbackMinutes: number;
  groupWindowMinutes: number;
  settleMinutes: number;
  seenTtlSeconds: number;
  slackChannel?: string;
  callToAction: string;
  summaryModel: string;
  dryRun: boolean;
}

/**
 * Most drafts one run may pull, and so the widest burst of concurrent Key Value
 * subtasks a run can open. `announcedDraftIds` and `markAnnounced` dispatch one
 * `ctx.run` per draft at once, so the limit and the burst are the same number.
 *
 * Capped at 50 because Typefully rejects a larger `limit` with a 422.
 */
export const MAX_LIMIT = 50;

interface Bounds {
  /** Used when the override is absent and the environment variable is unset or blank. */
  fallback: number;
  min: number;
  max?: number;
}

/**
 * Resolve run config from per-run overrides, then environment, then defaults.
 *
 * DRY_RUN defaults to true: the first deploy logs the note it would post and
 * writes nothing to Slack unless DRY_RUN is explicitly "false".
 *
 * The lookback default of 90 minutes covers the gap between the webhook event
 * and the run, plus any retry backoff, and it is wide enough that a manual
 * re-run catches a post whose delivery was dropped. The announced marker in Key
 * Value keeps the overlapping runs from re-posting what is already out.
 */
export function loadConfig(
  input: CheckPostsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): AmplifierConfig {
  const socialSetId = input.socialSetId ?? env.TYPEFULLY_SOCIAL_SET_ID;
  const slackChannel = channelName(input.slackChannel ?? env.SLACK_CHANNEL);
  const seenTtlDays = whole(
    "AMPLIFIER_SEEN_TTL_DAYS",
    input.seenTtlDays,
    env.AMPLIFIER_SEEN_TTL_DAYS,
    {
      fallback: 30,
      min: 1,
    },
  );

  return {
    ...(socialSetId ? { socialSetId } : {}),
    limit: whole("AMPLIFIER_LIMIT", input.limit, env.AMPLIFIER_LIMIT, {
      fallback: 25,
      min: 1,
      max: MAX_LIMIT,
    }),
    lookbackMinutes: whole(
      "AMPLIFIER_LOOKBACK_MINUTES",
      input.lookbackMinutes,
      env.AMPLIFIER_LOOKBACK_MINUTES,
      { fallback: 90, min: 1 },
    ),
    // A group window of 0 groups only drafts published at the same instant.
    // Set it to 0 to turn grouping off.
    groupWindowMinutes: whole(
      "AMPLIFIER_GROUP_WINDOW_MINUTES",
      input.groupWindowMinutes,
      env.AMPLIFIER_GROUP_WINDOW_MINUTES,
      { fallback: 10, min: 0 },
    ),
    // A settle window of 0 announces whatever links exist on the first attempt.
    // Set it to 0 to turn settling off. The maximum is the retry budget on
    // amplifier.handleEvent, past which the retries run out before the deadline
    // and the event produces no note at all.
    settleMinutes: whole(
      "AMPLIFIER_SETTLE_MINUTES",
      input.settleMinutes,
      env.AMPLIFIER_SETTLE_MINUTES,
      { fallback: 10, min: 0, max: MAX_SETTLE_MINUTES },
    ),
    seenTtlSeconds: seenTtlDays * 86_400,
    ...(slackChannel ? { slackChannel } : {}),
    callToAction: text(input.callToAction, env.AMPLIFIER_CALL_TO_ACTION, DEFAULT_CALL_TO_ACTION),
    summaryModel: text(input.summaryModel, env.AMPLIFIER_SUMMARY_MODEL, DEFAULT_SUMMARY_MODEL),
    dryRun: input.dryRun ?? env.DRY_RUN !== "false",
  };
}

/**
 * Strip the leading "#" Slack uses to display a channel. `chat.postMessage`
 * takes a bare name or an id, so accept both forms and store the bare one.
 */
function channelName(value: string | undefined): string | undefined {
  return value?.trim().replace(/^#/, "") || undefined;
}

/**
 * Resolve one string setting. A blank environment variable means "use the
 * default", matching `whole`: a declared-but-empty variable is the normal state
 * of a Render env var nobody filled in.
 */
function text(
  override: string | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  return override?.trim() || envValue?.trim() || fallback;
}

/**
 * Resolve one whole-number setting from the per-run override, then the
 * environment, then the default.
 *
 * An unset or blank environment variable means "use the default", because a
 * declared-but-empty variable is the normal state of a Render env var nobody
 * filled in. Any other unusable value throws. A value that resolved to 0
 * instead would make every run pull no drafts and post nothing, with no error
 * to read.
 */
function whole(
  name: string,
  override: number | undefined,
  envValue: string | undefined,
  { fallback, min, max }: Bounds,
): number {
  if (override === undefined && (envValue === undefined || envValue.trim() === "")) {
    return fallback;
  }
  const value = override ?? Number(envValue);
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `of at least ${min}` : `between ${min} and ${max}`;
    throw new Error(
      `${name} must be a whole number ${range}; got ` +
        `${override !== undefined ? override : JSON.stringify(envValue)}.`,
    );
  }
  return value;
}
