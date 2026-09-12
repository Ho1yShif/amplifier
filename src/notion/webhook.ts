import { createHmac } from "node:crypto";
import type { WebhookAdapter, WebhookContext, WebhookRequest } from "@render-lab/triggers";
import { timingSafeEquals } from "../http/signature.js";

/** The one event that can produce a DM. */
const PROPERTIES_UPDATED_EVENT = "page.properties_updated";

/** The header Notion signs a delivery with, lowercased the way the server hands it over. */
const SIGNATURE_HEADER = "x-notion-signature";

/** The envelope's `type`, or undefined. */
function eventType(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const type = (body as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/** The id of the entity the event is about, as a string, or undefined. */
function entityId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const entity = (body as { entity?: unknown }).entity;
  if (typeof entity !== "object" || entity === null) return undefined;
  const id = (entity as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * The token in a subscription handshake body, or undefined.
 *
 * Notion posts `{"verification_token": "..."}` once, unsigned, to the same URL
 * the events use. The single-key check is what tells the handshake from an
 * event: an event body carries `id`, `type` and `entity` as well.
 */
function verificationToken(rawBody: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return undefined;
  }
  if (typeof body !== "object" || body === null) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "verification_token") return undefined;
  const token = (body as { verification_token?: unknown }).verification_token;
  return typeof token === "string" && token !== "" ? token : undefined;
}

/**
 * The Notion adapter for `createDispatchServer`.
 *
 * `verify` is the only thing between the receiver's public URL and a workflow
 * run, because `POST /webhooks/:name` does not check `DISPATCH_TOKEN`.
 *
 * `now` is accepted for symmetry with `typefullyWebhook` and is unused: Notion
 * sends no timestamp to check.
 */
export function notionWebhook(
  opts: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): WebhookAdapter {
  const env = opts.env ?? process.env;

  return {
    /**
     * Recompute the HMAC-SHA256 over the raw body and compare it with
     * `X-Notion-Signature`. Notion signs the body alone, where Typefully signs
     * `${timestamp}.${rawBody}`.
     *
     * There is no freshness window. Notion sends no timestamp header and
     * retries a failed delivery for about 24 hours, so any window narrow
     * enough to stop a replay would also reject legitimate retries. What stops
     * a replay is the `amplifier:pinged:${pageId}` marker, which refuses the
     * second delivery for a page whose owners already got their DMs.
     *
     * With no secret configured, the one-time subscription handshake is
     * accepted and logged, because reading that token out of these logs is how
     * the secret gets configured in the first place. Every other delivery is
     * rejected, matching how `typefullyWebhook` answers with no secret.
     */
    verify({ headers, rawBody }: WebhookRequest): boolean {
      const secret = env.NOTION_WEBHOOK_SECRET;
      if (!secret) {
        const token = verificationToken(rawBody);
        if (token) {
          console.log(
            `[amplifier] Notion subscription handshake. Paste this verification token into ` +
              `the Notion webhook UI and into NOTION_WEBHOOK_SECRET: ${token}`,
          );
          return true;
        }
        console.error("[amplifier] NOTION_WEBHOOK_SECRET is unset, so every delivery is rejected.");
        return false;
      }

      const signature = headers[SIGNATURE_HEADER];
      if (signature === undefined) return false;
      const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
      return timingSafeEquals(`sha256=${digest}`, signature);
    },

    /**
     * Start a ping for an edited page, and ignore everything else.
     *
     * The handshake body and every event but `page.properties_updated` map to
     * null, so no run starts for them.
     *
     * `data.updated_properties` is not read. It lists property ids rather than
     * display names, so it cannot be compared with
     * `NOTION_TYPEFULLY_PROPERTY`. `amplifier.pingOwners` fetches the page
     * instead, which is the source of truth for both properties it needs.
     */
    map({ body }: WebhookContext) {
      if (eventType(body) !== PROPERTIES_UPDATED_EVENT) return null;
      const pageId = entityId(body);
      if (pageId === undefined) return null;
      return { task: "amplifier.pingOwners", args: [{ pageId }] };
    },
  };
}
