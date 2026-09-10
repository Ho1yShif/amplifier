// Entry point for the amplifier Workflow service.
//
// Importing the task modules registers amplifier.checkPosts and
// amplifier.handleEvent and, transitively, every task they compose —
// typefully.listPublished, llm.complete, amplifier.postNote, kv.lock,
// kv.unlock, kv.get, kv.set — because each module calls task(...) at load.
// They all register into the one shared @renderinc/sdk TaskRegistry.
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import "./amplifier/checkPosts.js";
import "./amplifier/handleEvent.js";

// Zero-dep smoke task, handy for verifying the service is live.
export const ping = task({ name: "ping" }, function ping(_ctx: TaskContext): string {
  return "pong";
});
