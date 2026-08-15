import { Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";

import { CliIo } from "../../../../../contracts/internal/src/cli/cli-io.ts";
import { renderEnvelope } from "../../../../../contracts/internal/src/cli/cli-output.ts";
import { currentOutputMode } from "../../../../../contracts/internal/src/cli/output-mode.ts";
import { CliFailureError } from "../../../../../contracts/internal/src/errors.ts";
import { reportCommandFailure } from "../../../command-failure.ts";

import type { EvalDocTopic } from "./content.ts";

import { EVAL_DOC_TOPICS } from "./content.ts";

const EVAL_DOCS_COMMAND_LABEL = "eval docs";
const ALL_TOPIC = "all";

interface EvalDocsIndexResult {
  readonly topics: readonly Pick<EvalDocTopic, "topic" | "title" | "summary">[];
}

interface EvalDocsTopicResult {
  readonly topic: string;
  readonly title: string;
  readonly body: string;
}

const topicArgument = Argument.string("topic").pipe(
  Argument.withDescription(
    `Topic to print (${EVAL_DOC_TOPICS.map(({ topic }) => topic).join(", ")}, or all)`
  ),
  Argument.optional
);

const formatIndex = (): string =>
  [
    "Eval reference topics:",
    ...EVAL_DOC_TOPICS.map(
      ({ topic, title, summary }) => `  ${topic}  ${title} - ${summary}`
    ),
    "",
    "Run `ori eval docs <topic>` for a section, or `ori eval docs all` for everything.",
    "",
  ].join("\n");

const allTopic = (): EvalDocTopic => ({
  body: EVAL_DOC_TOPICS.map(({ body }) => body).join("\n\n"),
  summary: "All eval reference topics.",
  title: "All eval reference",
  topic: ALL_TOPIC,
});

const findTopic = (topic: string): EvalDocTopic | undefined =>
  topic === ALL_TOPIC
    ? allTopic()
    : EVAL_DOC_TOPICS.find((entry) => entry.topic === topic);

export const evalDocsCommand = Command.make(
  "docs",
  { topic: topicArgument },
  ({ topic }) =>
    Effect.gen(function* () {
      const cliIo = yield* CliIo;
      const resolvedTopic = Option.getOrUndefined(topic);

      if (resolvedTopic === undefined) {
        if ((yield* currentOutputMode()) === "json") {
          const result: EvalDocsIndexResult = {
            topics: EVAL_DOC_TOPICS.map(
              ({ topic: topicName, title, summary }) => ({
                summary,
                title,
                topic: topicName,
              })
            ),
          };
          yield* cliIo.writeStdout(
            renderEnvelope(EVAL_DOCS_COMMAND_LABEL, result)
          );
          return;
        }

        yield* cliIo.writeStdout(formatIndex());
        return;
      }

      const selectedTopic = findTopic(resolvedTopic);
      if (selectedTopic === undefined) {
        const validTopics = `${EVAL_DOC_TOPICS.map(({ topic: topicName }) => topicName).join(", ")}, ${ALL_TOPIC}`;
        return yield* new CliFailureError({
          detail: `Unknown eval docs topic "${resolvedTopic}".`,
          hint: `Valid topics: ${validTopics}. Run \`ori eval docs\` to see the index.`,
        });
      }

      const result: EvalDocsTopicResult = {
        body: selectedTopic.body,
        title: selectedTopic.title,
        topic: selectedTopic.topic,
      };
      if ((yield* currentOutputMode()) === "json") {
        yield* cliIo.writeStdout(
          renderEnvelope(EVAL_DOCS_COMMAND_LABEL, result)
        );
        return;
      }

      yield* cliIo.writeStdout(`${selectedTopic.body.trim()}\n`);
    }).pipe(reportCommandFailure(EVAL_DOCS_COMMAND_LABEL))
).pipe(
  Command.withDescription(
    "Read the version-matched eval reference compiled into this CLI. Omit the topic for an index, or use `all` for every topic"
  )
);

export { EVAL_DOCS_COMMAND_LABEL };
