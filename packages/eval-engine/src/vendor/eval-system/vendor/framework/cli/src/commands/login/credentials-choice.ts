import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Prompt } from "effect/unstable/cli";

import type { GatewayAuthSource } from "../../../../contracts/internal/src/gateway-auth.ts";

import {
  decodeJsonString,
  encodeJsonString,
} from "../../../../contracts/internal/src/json.ts";
import {
  loadStoredGatewayKeyIntoEnvFrom,
  projectGatewayAuthSourceAtStartup,
  restoreDotenvGatewayCredentialAtStartup,
} from "./credentials.ts";
import { resolveStoredCredential } from "./credentials-resolve.ts";
import {
  ROUTEKIT_EVAL_DIRECTORY_NAME,
  RouteKitEvalDirectory,
} from "../../routekit-eval-directory.ts";

const WORKSPACE_CREDENTIAL_CHOICE_FILE_NAME = "gateway-auth.json";
const JSON_INDENT = 2;

const WorkspaceCredentialChoiceSchema = Schema.Struct({
  choice: Schema.Literals(["project", "stored"]),
}).annotate({ identifier: "WorkspaceCredentialChoice" });

type WorkspaceCredentialChoice = typeof WorkspaceCredentialChoiceSchema.Type;

const decodeWorkspaceCredentialChoice = decodeJsonString(
  WorkspaceCredentialChoiceSchema
);

const workspaceCredentialChoicePath = (
  path: Path.Path,
  workspaceRoot: string
): string =>
  path.join(
    workspaceRoot,
    ROUTEKIT_EVAL_DIRECTORY_NAME,
    WORKSPACE_CREDENTIAL_CHOICE_FILE_NAME
  );

const readWorkspaceCredentialChoice = Effect.fn(
  "WorkspaceCredentialChoice.read"
)(function* (workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = workspaceCredentialChoicePath(path, workspaceRoot);
  const exists = yield* fs
    .exists(filePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return Option.none<WorkspaceCredentialChoice>();
  }
  return yield* fs
    .readFileString(filePath)
    .pipe(Effect.flatMap(decodeWorkspaceCredentialChoice), Effect.option);
});

const writeWorkspaceCredentialChoice = Effect.fn(
  "WorkspaceCredentialChoice.write"
)(function* (input: {
  readonly choice: WorkspaceCredentialChoice["choice"];
  readonly workspaceRoot: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = workspaceCredentialChoicePath(path, input.workspaceRoot);
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const serialized = yield* encodeJsonString(
    WorkspaceCredentialChoiceSchema,
    JSON_INDENT
  )({ choice: input.choice });
  yield* fs.writeFileString(filePath, `${serialized}\n`);
});

const clearWorkspaceCredentialChoice = Effect.fn(
  "WorkspaceCredentialChoice.clear"
)(function* (workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .remove(workspaceCredentialChoicePath(path, workspaceRoot))
    .pipe(Effect.ignore);
});

const chooseProjectOrStoredCredential = Effect.fn(
  "WorkspaceCredentialChoice.chooseProjectOrStored"
)(function* (input: {
  readonly interactive: boolean;
  readonly projectSource: Option.Option<GatewayAuthSource>;
  readonly startDir: string;
  readonly startupProjectSource: Option.Option<GatewayAuthSource>;
  readonly workspaceRoot: string;
}) {
  const recorded = yield* readWorkspaceCredentialChoice(input.workspaceRoot);
  let choice: WorkspaceCredentialChoice["choice"];
  if (Option.isSome(recorded)) {
    ({ choice } = recorded.value);
  } else if (input.interactive) {
    choice = yield* Prompt.select<WorkspaceCredentialChoice["choice"]>({
      choices: [
        {
          title: "Project dotenv credential",
          value: "project",
        },
        {
          title: "Stored RouteKitEval credential",
          value: "stored",
        },
      ],
      message:
        "A project dotenv credential and a stored RouteKitEval credential are available. Which should this workspace use?",
    });
    yield* writeWorkspaceCredentialChoice({
      choice,
      workspaceRoot: input.workspaceRoot,
    }).pipe(Effect.ignore);
  } else {
    choice = "stored";
  }
  if (choice === "project") {
    if (Option.isSome(input.startupProjectSource)) {
      return yield* restoreDotenvGatewayCredentialAtStartup(
        input.workspaceRoot
      );
    }
    return input.projectSource;
  }
  return yield* loadStoredGatewayKeyIntoEnvFrom({
    startDir: input.startDir,
  });
});

const resolveProjectCredentialConflict = Effect.fn(
  "WorkspaceCredentialChoice.resolveConflict"
)(function* (input: {
  readonly existingSource: Option.Option<GatewayAuthSource>;
  readonly interactive: boolean;
  readonly startDir: string;
}) {
  const workspaceRoot = yield* (yield* RouteKitEvalDirectory).workspaceRootFrom(
    input.startDir
  );
  const startupProjectSource = yield* projectGatewayAuthSourceAtStartup();
  let projectSource = Option.none<GatewayAuthSource>();
  if (
    Option.isSome(startupProjectSource) &&
    startupProjectSource.value.kind === "project"
  ) {
    projectSource = startupProjectSource;
  } else if (
    Option.isSome(input.existingSource) &&
    input.existingSource.value.kind === "project"
  ) {
    projectSource = input.existingSource;
  }
  if (Option.isNone(workspaceRoot) || Option.isNone(projectSource)) {
    return Option.none<GatewayAuthSource>();
  }
  const stored = yield* resolveStoredCredential({ startDir: input.startDir });
  if (Option.isNone(stored)) {
    return Option.none<GatewayAuthSource>();
  }
  return yield* chooseProjectOrStoredCredential({
    interactive: input.interactive,
    projectSource,
    startDir: input.startDir,
    startupProjectSource,
    workspaceRoot: workspaceRoot.value,
  });
});

export {
  clearWorkspaceCredentialChoice,
  readWorkspaceCredentialChoice,
  resolveProjectCredentialConflict,
  writeWorkspaceCredentialChoice,
};
export type { WorkspaceCredentialChoice };
