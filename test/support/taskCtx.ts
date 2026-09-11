import { fakeCtx } from "@render-lab/test-utils";
import type { TaskContext, TaskDefinition } from "@renderinc/sdk/workflows";

/**
 * Fake task implementations, keyed by task name.
 *
 * `input` is `any` on purpose. Handlers stand in for tasks of unrelated
 * signatures dispatched through one `run`, so the type would have to be keyed
 * on each task's own input to say anything true. Typing it `unknown` instead
 * would only move the narrowing into every handler in every test.
 */
export type TaskHandlers = Record<string, (input: any) => unknown>;

/** One `ctx.run` call: the task's name and the input it received. */
export interface TaskCall {
  name: string;
  input: any;
}

/**
 * A TaskContext whose `run` dispatches by task name to `handlers`, and the
 * calls it made in order.
 *
 * An unhandled task name throws, so a test that chains something it did not
 * stub fails loudly instead of reading `undefined`.
 */
export function taskCtx(handlers: TaskHandlers): { ctx: TaskContext; calls: TaskCall[] } {
  const calls: TaskCall[] = [];
  const ctx = fakeCtx({
    run: (async (t: TaskDefinition<any, any>, input: any) => {
      calls.push({ name: t.name, input });
      const handler = handlers[t.name];
      if (!handler) throw new Error(`unexpected task ${t.name}`);
      return handler(input);
    }) as any,
  });
  return { ctx, calls };
}
