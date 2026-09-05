// Cron job entry point — a SEPARATE Render cron service, not the Workflow.
// Render Workflows have no built-in scheduler, so this dispatches the workflow
// on a schedule via @render-lab/triggers. Deploy as a Render cron job with
// WORKFLOW_SLUG + RENDER_API_KEY set; CRON_TASK / CRON_INPUT override the task
// and its args.
import { runCron } from "@render-lab/triggers";

runCron({ task: process.env.CRON_TASK ?? "amplifier.checkPosts" })
  .then((r) => {
    console.log(`dispatched ${r.runId}: ${r.status}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
