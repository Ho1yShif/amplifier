import { createHmac } from "node:crypto";

/**
 * The headers Slack signs a delivery with: HMAC-SHA256 over
 * `v0:{timestamp}:{rawBody}`, keyed by the signing secret.
 *
 * `timestamp` is whole seconds as a string, the way Slack sends it.
 */
export function slackSignedHeaders(rawBody: string, secret: string, timestamp: string) {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  return { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${digest}` };
}
