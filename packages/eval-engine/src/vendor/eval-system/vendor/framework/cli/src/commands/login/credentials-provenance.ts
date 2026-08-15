import { Effect, FileSystem, Option, Path } from "effect";

import type { GatewayAuthSource } from "../../../../contracts/internal/src/gateway-auth.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import {
  ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
  ROUTEKIT_EVAL_FORCE_BEARER_TOKEN_ENV,
} from "../../../../contracts/internal/src/gateway-auth.ts";
import { isTruthyEnvValue } from "../update/env-values.ts";

const DOTENV_KEY_PATTERN = new RegExp(
  `^\\s*(?:export\\s+)?${ROUTEKIT_EVAL_BEARER_TOKEN_ENV}\\s*=\\s*(.*?)\\s*$`,
  "u"
);
interface DotenvGatewayCredential {
  readonly source: GatewayAuthSource;
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
export const forceEnvironmentGatewayKey = Effect.fn(
  "LoginCredentials.forceEnvironmentKey"
)(function* () {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;
  return isTruthyEnvValue(env[ROUTEKIT_EVAL_FORCE_BEARER_TOKEN_ENV]);
});

/** Restores the snapshotted project value before reporting its source. */
export const restoreDotenvGatewayCredential = Effect.fn(
  "LoginCredentials.restoreDotenvCredential"
)(function* (credential: {
  readonly source: GatewayAuthSource;
  readonly value: string;
}) {
  const hostProcess = yield* HostProcess;
  yield* hostProcess.setEnv(ROUTEKIT_EVAL_BEARER_TOKEN_ENV, credential.value);
  const env = yield* hostProcess.env;
  return env[ROUTEKIT_EVAL_BEARER_TOKEN_ENV] === credential.value
    ? Option.some(credential.source)
    : Option.none<GatewayAuthSource>();
});

/** Reads authoritative Linux inheritance evidence, or returns unknown. */
export const inheritedGatewayKeyFromProcfs = Effect.fn(
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
    .find((value) => value.startsWith(`${ROUTEKIT_EVAL_BEARER_TOKEN_ENV}=`));
  if (entry === undefined) {
    return Option.some(false);
  }
  return Option.some(
    entry.slice(ROUTEKIT_EVAL_BEARER_TOKEN_ENV.length + 1) === liveValue
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

interface DotenvGatewayKeyDeclaration {
  readonly value: Option.Option<string>;
}

const parseDotenvGatewayApiKeyDeclaration = (
  contents: string
): Option.Option<DotenvGatewayKeyDeclaration> => {
  let key = Option.none<DotenvGatewayKeyDeclaration>();
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

const hasDotenvGatewayApiKeyDeclaration = (contents: string): boolean =>
  contents.split(/\r?\n/u).some((line) => DOTENV_KEY_PATTERN.test(line));

const isAcceptableDotenvDeclaration = (
  declaration: Option.Option<DotenvGatewayKeyDeclaration>,
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
export const parseDotenvGatewayApiKey = (
  contents: string
): string | undefined =>
  Option.getOrUndefined(
    Option.flatMap(
      parseDotenvGatewayApiKeyDeclaration(contents),
      ({ value }) => value
    )
  );

/** Uses value equality for inference and declaration presence for authoritative negatives. */
export const resolveDotenvGatewayKey = Effect.fn(
  "LoginCredentials.resolveDotenvGatewayKey"
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
    const liveValue = valueOverride ?? env[ROUTEKIT_EVAL_BEARER_TOKEN_ENV];
    if (liveValue === undefined) {
      return Option.none<DotenvGatewayCredential>();
    }
    for (let directory = startDir; ; directory = path.dirname(directory)) {
      for (const name of names) {
        const filePath = path.join(directory, name);
        const contents = yield* fs.readFileString(filePath).pipe(Effect.option);
        if (
          Option.isNone(contents) ||
          !hasDotenvGatewayApiKeyDeclaration(contents.value)
        ) {
          continue;
        }
        if (
          !isAcceptableDotenvDeclaration(
            parseDotenvGatewayApiKeyDeclaration(contents.value),
            liveValue,
            options?.allowAnyDeclaration ?? false
          )
        ) {
          return Option.none<DotenvGatewayCredential>();
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
    return Option.none<DotenvGatewayCredential>();
  }).pipe(
    Effect.orElseSucceed(() => Option.none<DotenvGatewayCredential>())
  );
});
/** Applies the inference or authoritative-negative dotenv resolution path. */
export const isDotenvGatewayKey = Effect.fn(
  "LoginCredentials.isDotenvGatewayKey"
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
  return yield* resolveDotenvGatewayKey(startDir, undefined, {
    allowAnyDeclaration: allowAny,
    ...(boundary === undefined ? {} : { workspaceRoot: boundary }),
  }).pipe(Effect.map(Option.map(({ source }) => source)));
});
