// ORI-owned local install of the `pi` runtime.
//
// Global installs that hardlink package files out of a cache break on Android
// proot-distro (Termux): proot's link2symlink extension emulates those hard
// links by renaming the real file to `/.l2s/.l2s.<name>NNNN` and pointing
// symlinks at it. `pi`'s `dist/cli.js` then realpath-resolves to a bare
// `/.l2s/...` file with no `./config.js` sibling, so pi crashes at startup.
// Copy-installed files (`npm install --ignore-scripts`) avoid the hardlink
// path entirely, so ORI installs its pinned pi into a private versioned
// directory (`~/.ori/pi-runtime/<version>`) and spawns that `dist/cli.js`
// directly. This also makes the version pin real: a user-installed global pi
// on PATH no longer shadows it. `ORI_PI_BIN` remains the authoritative
// override and still disables auto-install.

import type { HarnessProcessBinaryRequirement } from "../../../ori/src/process.ts";

import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { Data, Effect, Fiber, Option, Result, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  detectMissingHarnessProcessBinary,
  normalizeEnvValue,
  stderrTail,
} from "../../../ori/src/process.ts";

import { resolveNpm } from "../harness/bun-resolution.ts";

export const ORI_PI_BIN_ENV = "ORI_PI_BIN";
const ORI_PI_INSTALL_DIR_ENV = "ORI_PI_INSTALL_DIR";
// The human-facing install command shown in failure hints. The ACTUAL binary
// spawned is PATH-resolved by `resolveNpm`; the operator hint stays
// `npm install --ignore-scripts` because that is what a person would run to
// install pi themselves.
const PI_INSTALL_BINARY = "npm";
export const PI_BINARY = "pi";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
// The pinned `pi` version ori supports. Auto-install resolves to this exact
// version (not npm `latest`) so a published pi release cannot silently change
// the harness's observed behavior. Bump deliberately, in lockstep with testing
// against the new pi.
const PI_VERSION = "0.80.2";
const PI_PACKAGE_SPEC = `${PI_PACKAGE}@${PI_VERSION}`;
// `npm install --ignore-scripts` against the manifest written below. npm
// copy-installs by default, which is load-bearing for the l2s/hardlink
// issue: see the module header. The `@openrouter/agent` SDK that the
// web-tools extension imports is installed separately into a `node_modules`
// sibling of the materialized `web-tools.ts` (see `setUpWebToolsExtension`).
const PI_INSTALL_ARGS = ["install", "--ignore-scripts"] as const;
const PI_INSTALL_COMMAND = `${PI_INSTALL_BINARY} ${PI_INSTALL_ARGS.join(" ")}`;
const PI_RUNTIME_BASE_DIR = ".ori";
const PI_RUNTIME_SUBDIR = "pi-runtime";
// pi-coding-agent's `@earendil-works/*` runtime siblings are published from the
// same monorepo at the same version, but it declares them as caret ranges
// (`^<version>`). A bare install therefore drifts a sibling forward the moment
// it publishes past the pinned agent — and pi-ai did exactly that: a release
// after 0.80.2 turned its `dist/oauth.js` barrel into an empty `export {}`, so
// the pinned agent's `import { getOAuthProviders } from
// "@earendil-works/pi-ai/oauth"` throws `SyntaxError: Export named
// 'getOAuthProviders' not found` at startup and every pi turn crashes. Pin the
// whole sibling set to the exact PI_VERSION via npm `overrides` so the install
// is reproducible and lockstep with the pinned agent; `overrides` also rewrites
// nested edges (e.g. pi-tui → pi-ai), not just top-level ones. Keep this list
// current when bumping PI_VERSION: add any new `@earendil-works/*` runtime dep
// of the pinned pi-coding-agent (`npm view <spec> dependencies`).
export const PI_EARENDIL_SIBLING_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-agent-core",
] as const;

const PI_RUNTIME_OVERRIDES: Readonly<Record<string, string>> =
  Object.fromEntries(
    PI_EARENDIL_SIBLING_PACKAGES.map((pkg) => [pkg, PI_VERSION])
  );
// A minimal project manifest so the install dir is a genuine project root with
// the exact pin (no caret) plus the sibling `overrides` above. Overwritten
// unconditionally — the dir is ORI-owned.
export const PI_RUNTIME_MANIFEST = `${JSON.stringify(
  {
    dependencies: { [PI_PACKAGE]: PI_VERSION },
    name: "ori-pi-runtime",
    overrides: PI_RUNTIME_OVERRIDES,
    private: true,
    type: "module",
    version: "0.0.0",
  },
  null,
  2
)}\n`;
const PI_MANIFEST_FILENAME = "package.json";
const PI_LOCAL_CLI_SEGMENTS = [
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
] as const;
// proot's link2symlink emulation renames a hardlinked file to
// `.l2s.<name>NNNN`; a cli.js whose realpath basename carries that prefix is
// unusable (its relative imports have no siblings) and must be reinstalled.
const L2S_REALPATH_PREFIX = ".l2s.";

// Only surfaced when an explicit ORI_PI_BIN probe fails
// (formatMissingHarnessProcessBinary in process-stream.ts); the auto-managed
// path never consults PATH.
export const PI_BINARY_REQUIREMENT = {
  binaryEnvVar: ORI_PI_BIN_ENV,
  installCommand: `npm install --ignore-scripts ${PI_PACKAGE_SPEC} (ori normally auto-installs pi)`,
} satisfies HarnessProcessBinaryRequirement;

interface PiInstallResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

// Versioned so a pin bump lands in a fresh dir and reinstalls cleanly (stale
// version dirs linger; cleanup is out of scope).
export const resolvePiRuntimeInstallDir = (env: NodeJS.ProcessEnv): string =>
  join(
    normalizeEnvValue(env[ORI_PI_INSTALL_DIR_ENV]) ??
      join(homedir(), PI_RUNTIME_BASE_DIR, PI_RUNTIME_SUBDIR),
    PI_VERSION
  );

export const piLocalCliPath = (installDir: string): string =>
  join(installDir, ...PI_LOCAL_CLI_SEGMENTS);

export const isL2sMangledRealpath = (realPath: string): boolean =>
  basename(realPath).startsWith(L2S_REALPATH_PREFIX);

// Returns the NON-canonical cli.js path (symlink following stays
// `resolvePiInvocation`'s job); undefined when the file is missing, not a
// regular file, unreadable, or its realpath is l2s-mangled (a dir
// hardlink-installed by an older ori under proot self-heals via reinstall).
export const detectInstalledPiCli = async (
  installDir: string
): Promise<string | undefined> => {
  const cliPath = piLocalCliPath(installDir);
  try {
    const info = await stat(cliPath);
    if (!info.isFile()) {
      return undefined;
    }
    return isL2sMangledRealpath(await realpath(cliPath)) ? undefined : cliPath;
  } catch {
    return undefined;
  }
};

const formatPiInstallSpawnError = (error: PiInstallError): string =>
  `automatic pi install failed: ${error.message}. Retry, or install pi yourself and set ${ORI_PI_BIN_ENV}.`;

const formatFailedPiInstallResult = (result: PiInstallResult): string => {
  const output = stderrTail(result.stderr) ?? stderrTail(result.stdout);
  const detail =
    output === undefined
      ? `automatic pi install (${PI_INSTALL_COMMAND}) exited with code ${result.exitCode}`
      : `automatic pi install (${PI_INSTALL_COMMAND}) exited with code ${result.exitCode}. output: ${output}`;
  return `${detail}. Retry, or install pi yourself and set ${ORI_PI_BIN_ENV}.`;
};

const formatMissingInstalledCli = (cliPath: string): string =>
  `Automatic pi install completed, but the pi entrypoint was not found (or is unusable) at ${cliPath}. Set ${ORI_PI_BIN_ENV} to a working pi.`;

/**
 * A failure spawning or reading the pinned `npm install --ignore-scripts`
 * step. The original failure is kept in `cause`; `message` mirrors the
 * underlying error text so {@link formatPiInstallSpawnError} renders the same
 * actionable hint as before.
 */
class PiInstallError extends Data.TaggedError("PiInstallError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const toInstallError = (cause: unknown): PiInstallError =>
  new PiInstallError({
    cause,
    message:
      cause instanceof Error
        ? cause.message
        : `Failed to run ${PI_INSTALL_COMMAND}: ${String(cause)}`,
  });

const readProcessText = Effect.fn("PiHarness.readProcessText")(function* (
  stream: Stream.Stream<Uint8Array, unknown>
) {
  return yield* stream.pipe(
    Stream.mapError(toInstallError),
    Stream.decodeText(),
    Stream.mkString
  );
});

// PATH-resolves `npm` and runs `npm install --ignore-scripts` against the
// ORI-owned manifest. Two concurrent invokes may race this install in the
// same dir; npm's own lockfile makes that benign — the same accepted risk as
// `ensureWebToolsSdk`.
const installPiLocally = Effect.fn("PiHarness.installLocally")(
  function* (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly installDir: string;
  }) {
    yield* Effect.tryPromise({
      catch: toInstallError,
      try: async () => {
        await mkdir(input.installDir, { recursive: true });
        await writeFile(
          join(input.installDir, PI_MANIFEST_FILENAME),
          PI_RUNTIME_MANIFEST,
          "utf-8"
        );
      },
    });

    const npm = yield* Effect.promise(() => resolveNpm(input.env));
    const handle = yield* ChildProcess.make(npm, PI_INSTALL_ARGS, {
      cwd: input.installDir,
      env: input.env,
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    }).pipe(Effect.mapError(toInstallError));
    const stderrFiber = yield* readProcessText(handle.stderr).pipe(
      Effect.forkScoped
    );
    const stdoutFiber = yield* readProcessText(handle.stdout).pipe(
      Effect.forkScoped
    );
    const exitCode = yield* handle.exitCode.pipe(
      Effect.map(Number),
      Effect.mapError(toInstallError)
    );
    const stderr = yield* Fiber.join(stderrFiber);
    const stdout = yield* Fiber.join(stdoutFiber);

    return {
      exitCode,
      stderr,
      stdout,
    } satisfies PiInstallResult;
  }
);

//   * `ORI_PI_BIN` set (autoInstall false): the override is authoritative —
//     probe it like any harness binary and pass it through. No l2s logic; the
//     runtime stderr hint covers a mangled override.
//   * Auto-managed (default): PATH is never consulted. Use the ORI-owned
//     versioned install, creating or self-healing it as needed.
export const ensurePiBinary = Effect.fn("PiHarness.ensureBinary")(
  function* (input: {
    readonly autoInstall: boolean;
    readonly binary: string;
    readonly env: NodeJS.ProcessEnv;
    readonly missingBinary: HarnessProcessBinaryRequirement;
  }) {
    if (!input.autoInstall) {
      const missing = yield* detectMissingHarnessProcessBinary(input);
      return Option.isSome(missing)
        ? Result.fail(missing.value)
        : Result.succeed(input.binary);
    }

    const installDir = resolvePiRuntimeInstallDir(input.env);
    const installed = yield* Effect.promise(() =>
      detectInstalledPiCli(installDir)
    );
    if (installed !== undefined) {
      return Result.succeed(installed);
    }

    const installResult = yield* installPiLocally({
      env: input.env,
      installDir,
    }).pipe(Effect.result);
    if (Result.isFailure(installResult)) {
      return Result.fail(formatPiInstallSpawnError(installResult.failure));
    }
    if (installResult.success.exitCode !== 0) {
      return Result.fail(formatFailedPiInstallResult(installResult.success));
    }

    const installedAfter = yield* Effect.promise(() =>
      detectInstalledPiCli(installDir)
    );
    return installedAfter === undefined
      ? Result.fail(formatMissingInstalledCli(piLocalCliPath(installDir)))
      : Result.succeed(installedAfter);
  }
);
