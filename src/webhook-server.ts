// Webhook receiver entry point — a SEPARATE Render web service, not the Workflow.
// Its only job is to verify an inbound request and start a run. Everything after
// the HTTP boundary is a registered workflow task with a retry policy.
//
// Deploy as a Render web service with WORKFLOW_SLUG + RENDER_API_KEY set, plus
// TYPEFULLY_WEBHOOK_SECRET from the Typefully dashboard and SLACK_SIGNING_SECRET
// from the Slack app. @hono/node-server binds $PORT on all interfaces, and
// GET /healthz is the Render health check path.
import { serve } from "@hono/node-server";
import { renderDispatcher } from "@render-lab/triggers";
import { buildReceiver } from "./receiver.js";

// Refuse to boot without a slug, rather than pass "" to the dispatcher. An
// empty slug still answers the health check, so the service would deploy green
// and fail on its first webhook instead of failing the deploy.
const slug = process.env.WORKFLOW_SLUG;
if (!slug) {
  throw new Error(
    "WORKFLOW_SLUG is required for the webhook receiver. Set it to the Workflow " +
      "service's slug, which is in its Render dashboard URL.",
  );
}
const app = buildReceiver({ dispatcher: renderDispatcher({ slug }), workflowSlug: slug });
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
