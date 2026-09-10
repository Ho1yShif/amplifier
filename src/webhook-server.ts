// Webhook receiver entry point — a SEPARATE Render web service, not the Workflow.
// Its only job is to verify a Typefully delivery and start a run. Everything
// after the HTTP boundary is a registered workflow task with a retry policy.
//
// Deploy as a Render web service with WORKFLOW_SLUG + RENDER_API_KEY set, plus
// TYPEFULLY_WEBHOOK_SECRET from the Typefully dashboard. `serveDispatchServer`
// binds $PORT on all interfaces and serves GET /healthz, which is the Render
// health check path.
import { serveDispatchServer } from "@render-lab/triggers";
import { typefullyWebhook } from "./typefully/webhook.js";

serveDispatchServer({ webhooks: { typefully: typefullyWebhook() } });
