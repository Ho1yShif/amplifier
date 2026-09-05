import { DEFAULT_CALL_TO_ACTION } from "./amplifier/template.js";

/** Overrides accepted per run; anything omitted falls back to env, then defaults. */
export interface CheckPostsInput {
  socialSetId?: string;
  limit?: number;
  lookbackMinutes?: number;
  groupWindowMinutes?: number;
  seenTtlDays?: number;
  slackChannel?: string;
  callToAction?: string;
  dryRun?: boolean;
  /** ISO 8601 "now", for tests and for replaying a past window. */
  now?: string;
}

export interface AmplifierConfig {
  socialSetId?: string;
  limit: number;
  lookbackMinutes: number;
  groupWindowMinutes: number;
  seenTtlSeconds: number;
  slackChannel?: string;
  callToAction: string;
  dryRun: boolean;
}

/**
 * Resolve run config from per-run overrides, then environment, then defaults.
 *
 * DRY_RUN defaults to true: the first deploy logs the note it would post and
 * writes nothing to Slack unless DRY_RUN is explicitly "false".
 *
 * The lookback default of 90 minutes is wider than the 30-minute cron
 * schedule, so one skipped run still catches up. The announced marker in Key
 * Value keeps the overlapping runs from re-posting what is already out.
 */
export function loadConfig(
  input: CheckPostsInput = {},
  env: NodeJS.ProcessEnv = process.env,
): AmplifierConfig {
  const socialSetId = input.socialSetId ?? env.TYPEFULLY_SOCIAL_SET_ID;
  const slackChannel = input.slackChannel ?? env.SLACK_CHANNEL;
  const seenTtlDays = input.seenTtlDays ?? numberFromEnv(env.AMPLIFIER_SEEN_TTL_DAYS, 30);

  return {
    ...(socialSetId ? { socialSetId } : {}),
    limit: input.limit ?? numberFromEnv(env.AMPLIFIER_LIMIT, 25),
    lookbackMinutes: input.lookbackMinutes ?? numberFromEnv(env.AMPLIFIER_LOOKBACK_MINUTES, 90),
    groupWindowMinutes:
      input.groupWindowMinutes ?? numberFromEnv(env.AMPLIFIER_GROUP_WINDOW_MINUTES, 10),
    seenTtlSeconds: seenTtlDays * 86_400,
    ...(slackChannel ? { slackChannel } : {}),
    callToAction: input.callToAction ?? env.AMPLIFIER_CALL_TO_ACTION ?? DEFAULT_CALL_TO_ACTION,
    dryRun: input.dryRun ?? env.DRY_RUN !== "false",
  };
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number(value);
  return Number.isFinite(n) ? n : fallback;
}
