import { Effect, FileSystem, Option, Path } from "effect";

import type { OpenRouterAuthSource } from "../../../../contracts/internal/src/openrouter-auth.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import {
  OPENROUTER_API_KEY_ENV,
  ORI_FORCE_OPENROUTER_API_KEY_ENV,
} from "../../../../contracts/internal/src/openrouter-auth.ts";
import { isTruthyEnvValue } from "../update/env-values.ts";

const DOTENV_KEY_PATTERN = new RegExp(
  `^\\s*(?:export\\s+)?${OPENROUTER_API_KEY_ENV}\\s*=\\s*(.*?)\\s*$`,
  "u"
);
interface DotenvOpenRouterCredential {
  readonly source: OpenRouterAuthSource;
  readonly value: string;
}

/** Finds the boundary used to bound authoritative-negative provenance walks. */
export const findProjectBoundary = Effect.fn(
  "LoginCredentials.findProjectBoundary"
)(function* (startDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (
    let directory = path.resolve(startDir);
    ;
    directory = path.dirname(directory)
  ) {
    const hasWorkspaceMarker = yield* fs
      .exists(path.join(directory, "features"))
      .pipe(Effect.option);
    const hasRepositoryMarker = yield* fs
      .exists(path.join(directory, ".git"))
      .pipe(Effect.option);
    if (Option.isSome(hasWorkspaceMarker) && hasWorkspaceMarker.value) {
      return directory;
    }
    if (Option.isSome(hasRepositoryMarker) && hasRepositoryMarker.value) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return;
    }
  }
});

/** Forces the environment path without consulting provenance. */
export const forceEnvironmentOpenRouterKey = Effect.fn(
  "LoginCredentials.forceEnvironmentKey"
)(function* () {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  return isTruthyEnvValue(env[ORI_FORCE_OPENROUTER_API_KEY_ENV]);
});

/** Restores the snapshotted project value before reporting its source. */
export const restoreDotenvOpenRouterCredential = Effect.fn(
  "LoginCredentials.restoreDotenvCredential"
)(function* (credential: {
  readonly source: OpenRouterAuthSource;
  readonly value: string;
}) {
  const hostProcess = yield* HostProcess;
  yield* hostProcess.setEnv(OPENROUTER_API_KEY_ENV, credential.value);
  const env = yield* hostProcess.env;
  return env[OPENROUTER_API_KEY_ENV] === credential.value
    ? Option.some(credential.source)
    : Option.none<OpenRouterAuthSource>();
});

/** Reads authoritative Linux inheritance evidence, or returns unknown. */
export const inheritedOpenRouterKeyFromProcfs = Effect.fn(
  "LoginCredentials.procfsEnvironmentKey"
)(function* (liveValue: string, answer?: boolean) {
  if (answer !== undefined) {
    return Option.some(answer);
  }
  if (globalThis.process.platform !== "linux") {
    return Option.none<boolean>();
  }
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs
    .readFileString("/proc/self/environ")
    .pipe(Effect.option);
  if (Option.isNone(contents) || contents.value.length === 0) {
    return Option.none<boolean>();
  }
  const entry = contents.value
    .split("\0")
    .find((value) => value.startsWith(`${OPENROUTER_API_KEY_ENV}=`));
  if (entry === undefined) {
    return Option.some(false);
  }
  return Option.some(
    entry.slice(OPENROUTER_API_KEY_ENV.length + 1) === liveValue
  );
});

const parseDotenvValue = (value: string): Option.Option<string> => {
  const trimmed = value.trim();
  if (trimmed === "" || /\$\{[^}]+\}/u.test(trimmed)) {
    return trimmed === "" ? Option.some("") : Option.none<string>();
  }
  const [quote] = trimmed;
  if (quote === '"' || quote === "'") {
    const closingQuote = trimmed.indexOf(quote, 1);
    if (closingQuote > 0) {
      return Option.some(trimmed.slice(1, closingQuote));
    }
    return Option.none<string>();
  }
  return Option.some(trimmed.replace(/\s+#.*$/u, "").trim());
};

interface DotenvOpenRouterKeyDeclaration {
  readonly value: Option.Option<string>;
}

const parseDotenvOpenRouterApiKeyDeclaration = (
  contents: string
): Option.Option<DotenvOpenRouterKeyDeclaration> => {
  let key = Option.none<DotenvOpenRouterKeyDeclaration>();
  for (const line of contents.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const match = DOTENV_KEY_PATTERN.exec(line);
    if (match !== null) {
      key = Option.some({
        value: parseDotenvValue(match[1]),
      });
    }
  }
  return key;
};

const hasDotenvOpenRouterApiKeyDeclaration = (contents: string): boolean =>
  contents.split(/\r?\n/u).some((line) => DOTENV_KEY_PATTERN.test(line));

const isAcceptableDotenvDeclaration = (
  declaration: Option.Option<DotenvOpenRouterKeyDeclaration>,
  liveValue: string,
  allowAnyDeclaration: boolean
): boolean => {
  if (Option.isNone(declaration)) {
    return false;
  }
  const { value } = declaration.value;
  if (Option.isNone(value)) {
    return allowAnyDeclaration;
  }
  return value.value !== "" && value.value === liveValue;
};

/** Parses the supported dotenv assignment forms for inference comparisons. */
export const parseDotenvOpenRouterApiKey = (
  contents: string
): string | undefined =>
  Option.getOrUndefined(
    Option.flatMap(
      parseDotenvOpenRouterApiKeyDeclaration(contents),
      ({ value }) => value
    )
  );

/** Uses value equality for inference and declaration presence for authoritative negatives. */
export const resolveDotenvOpenRouterKey = Effect.fn(
  "LoginCredentials.resolveDotenvOpenRouterKey"
)(function* (
  startDir: string,
  valueOverride?: string,
  options?: {
    readonly allowAnyDeclaration?: boolean;
    readonly workspaceRoot?: string;
  }
) {
  return yield* Effect.gen(function* () {
    const hostProcess = yield* HostProcess;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = yield* hostProcess.env;
    const nodeEnv = env.NODE_ENV ?? "development";
    const names = [
      `.env.${nodeEnv}.local`,
      ...(nodeEnv === "test" ? [] : [".env.local"]),
      `.env.${nodeEnv}`,
      ".env",
    ];
    const liveValue = valueOverride ?? env[OPENROUTER_API_KEY_ENV];
    if (liveValue === undefined) {
      return Option.none<DotenvOpenRouterCredential>();
    }
    for (let directory = startDir; ; directory = path.dirname(directory)) {
      for (const name of names) {
        const filePath = path.join(directory, name);
        const contents = yield* fs.readFileString(filePath).pipe(Effect.option);
        if (
          Option.isNone(contents) ||
          !hasDotenvOpenRouterApiKeyDeclaration(contents.value)
        ) {
          continue;
        }
        if (
          !isAcceptableDotenvDeclaration(
            parseDotenvOpenRouterApiKeyDeclaration(contents.value),
            liveValue,
            options?.allowAnyDeclaration ?? false
          )
        ) {
          return Option.none<DotenvOpenRouterCredential>();
        }
        return Option.some({
          source: {
            kind: "project" as const,
            location: filePath,
          },
          value: liveValue,
        });
      }
      const parent = path.dirname(directory);
      if (
        options?.workspaceRoot === undefined ||
        parent === directory ||
        directory === options?.workspaceRoot
      ) {
        break;
      }
    }
    return Option.none<DotenvOpenRouterCredential>();
  }).pipe(
    Effect.orElseSucceed(() => Option.none<DotenvOpenRouterCredential>())
  );
});
/** Applies the inference or authoritative-negative dotenv resolution path. */
export const isDotenvOpenRouterKey = Effect.fn(
  "LoginCredentials.isDotenvOpenRouterKey"
)(function* (
  startDir: string,
  allowAnyDeclaration?: boolean,
  workspaceRoot?: string
) {
  const allowAny = allowAnyDeclaration ?? false;
  const boundary =
    allowAny && workspaceRoot === undefined
      ? yield* findProjectBoundary(startDir)
      : workspaceRoot;
  return yield* resolveDotenvOpenRouterKey(startDir, undefined, {
    allowAnyDeclaration: allowAny,
    ...(boundary === undefined ? {} : { workspaceRoot: boundary }),
  }).pipe(Effect.map(Option.map(({ source }) => source)));
});
