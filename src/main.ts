// Entry point for the amplifier Workflow service.
//
// Importing the task modules registers amplifier.checkPosts,
// amplifier.handleEvent, amplifier.announcePost, amplifier.repost,
// amplifier.saveUserToken and amplifier.pingOwners and, transitively, every
// task they compose — typefully.listPublished, notion.getPage, llm.complete,
// amplifier.postNote, amplifier.lookupUser, amplifier.openDm,
// slack.addReaction, kv.lock, kv.unlock, kv.get, kv.set, kv.delete — because
// each module calls task(...) at load.
// They all register into the one shared @renderinc/sdk TaskRegistry.
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import "./amplifier/announcePost.js";
import "./amplifier/checkPosts.js";
import "./amplifier/handleEvent.js";
import "./amplifier/pingOwners.js";
import "./amplifier/repost.js";
import "./amplifier/saveUserToken.js";

// Zero-dep smoke task, handy for verifying the service is live.
export const ping = task({ name: "ping" }, function ping(_ctx: TaskContext): string {
  return "pong";
});
