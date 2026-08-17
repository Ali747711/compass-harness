// Adapted from opencode (MIT). Source: packages/opencode/src/tool/task.ts
// https://github.com/anomalyco/opencode — see licenses/opencode-MIT.txt
//
// Diverges from the original: background subagents (which inject their result
// into the parent as a synthetic user message) and `task_id` resumption are not
// here yet. Depth limiting, the permission ask, and the child-session model are.

import { Effect, Schema } from "effect"
import { agents } from "../agent/agent"
import { ToolFailure, make } from "./tool"
import DESCRIPTION from "./task.txt"

export const task = make({
  description: DESCRIPTION,
  input: Schema.Struct({
    description: Schema.String.annotate({ description: "A three to five word description of the task" }),
    prompt: Schema.String.annotate({
      description: "The task for the agent to perform, stated in full — it cannot see this conversation",
    }),
    subagent_type: Schema.String.annotate({ description: "Which agent to delegate to" }),
  }),
  execute: (input, context) =>
    Effect.gen(function* () {
      const spawn = context.spawn
      if (spawn === undefined) {
        return yield* new ToolFailure({ message: "Delegation is not available here." })
      }

      const available = agents(context.directory)
      const chosen = available.find((agent) => agent.name === input.subagent_type)
      if (chosen === undefined) {
        return yield* new ToolFailure({
          message: `Unknown agent "${input.subagent_type}". Available: ${available.map((a) => a.name).join(", ")}.`,
        })
      }

      // The parent receives the child's answer and nothing else. Its
      // intermediate turns are the entire reason to delegate — they stay in the
      // child session, on disk, out of the parent's context.
      const answer = yield* spawn({ agent: chosen.name, description: input.description, prompt: input.prompt })
      return { title: input.description, output: answer, metadata: { agent: chosen.name } }
    }),
})
