// Entry point for the amplifier Workflow service.
//
// Importing the task modules registers amplifier.checkPosts and, transitively,
// every task it composes — typefully.listPublished, slack.postMessage, kv.lock,
// kv.unlock, kv.get — because each module calls task(...) at load. They all
// register into the one shared @renderinc/sdk TaskRegistry.
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import "./amplifier/checkPosts.js";

// Zero-dep smoke task, handy for verifying the service is live.
export const ping = task({ name: "ping" }, function ping(ctx: TaskContext): string {
  return "pong";
});
