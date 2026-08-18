import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Option, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { resolveNpm } from "../harness/bun-resolution.ts";
import { resolvePiAgentDir } from "../openrouter-attribution/openrouter-attribution.ts";

// The web-tools extension source, embedded as text so it travels INSIDE a
// compiled single-file binary (an on-disk sibling .ts would not exist at
// runtime in a compiled CLI). At spawn we materialize this to a real file and
// hand that path to the external `pi` process via `--extension`. Mirrors the
// `.ts.txt` embed convention used by framework/cli init author-contracts. The
// `.ts.txt` twin is kept byte-identical to `extensions/web-tools.ts` (the real
// typechecked/linted source) by `extensions/web-tools.embed.test.ts`.
import webToolsSsrfSource from "./web-tools-ssrf.ts.txt";
import webToolsExtensionSource from "./web-tools.ts.txt";

const WEB_TOOLS_DIR = "web-tools";
const WEB_TOOLS_FILENAME = "web-tools.ts";
// The SSRF/HTML helper sibling `web-tools.ts` imports via a relative `.ts`
// specifier. It must be materialized next to `web-tools.ts` so pi's jiti loader
// resolves the import from the on-disk extension file (a compiled binary has no
// sibling on disk otherwise). Kept byte-identical to its source by the embed test.
const WEB_TOOLS_SSRF_FILENAME = "web-tools-ssrf.ts";
const WEB_TOOLS_PACKAGE_JSON_FILENAME = "package.json";
const NODE_MODULES_DIR = "node_modules";
// The web-tools extension dynamically imports `@openrouter/agent` (callModel +
// web_search server tool). Pinned to the exact version the extension typechecks
// against (the package's devDependency); bump in lockstep with the devDependency.
const WEB_TOOLS_SDK_PACKAGE = "@openrouter/agent";
export const WEB_TOOLS_SDK_VERSION = "0.7.2";
// A local `npm install --ignore-scripts` inside the materialized web-tools
// dir, so the SDK lands in a `node_modules` on the extension file's
// resolution walk-up path. Runs at most once per dir (gated on whether the
// package already resolves there). The package.json written below already
// pins the spec, so this install has no extra package arguments.
const WEB_TOOLS_SDK_INSTALL_ARGS = ["install", "--ignore-scripts"] as const;
// A minimal `package.json` written alongside `web-tools.ts` so the dir is a
// genuine project root: it gives `npm install` an anchor and gives jiti's
// filesystem resolution a `node_modules` to walk up into. `private` +
// `type: module` mirror the extension's ESM dynamic import; the declared
// dependency pins the SDK to the same version as the compiled-in extension.
const WEB_TOOLS_PACKAGE_JSON = `${JSON.stringify(
  {
    dependencies: { [WEB_TOOLS_SDK_PACKAGE]: WEB_TOOLS_SDK_VERSION },
    name: "ori-pi-web-tools",
    private: true,
    type: "module",
    version: "0.0.0",
  },
  null,
  2
)}\n`;

// The external `pi` process loads this via `--extension`, so it must be a
// genuine on-disk path — a virtual path from a compiled binary's
// `import.meta.url` is unreadable by a separate process.
// `--extension` is honored even under `--no-extensions`, so the built-in
// web_search / web_fetch tools are always available with no per-workspace
// setup. Best-effort: a write failure must not block the run, so the caller
// treats a missing path as "skip the flag".
const materializeWebToolsExtension = async (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const dir = join(resolvePiAgentDir(env), WEB_TOOLS_DIR);
  const target = join(dir, WEB_TOOLS_FILENAME);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(target, webToolsExtensionSource, "utf-8");
    // The SSRF/HTML sibling the extension imports relatively; jiti resolves it
    // from this on-disk path. Written before the flag is handed back so the
    // relative import never dangles.
    await writeFile(
      join(dir, WEB_TOOLS_SSRF_FILENAME),
      webToolsSsrfSource,
      "utf-8"
    );
    // Write a package.json anchor so the dir is a project root: it gives
    // jiti's filesystem resolution a node_modules to walk up into and gives a
    // local `npm install` an anchor. Best-effort — a missing anchor only means
    // the SDK install below has no project root, which surfaces as a tool
    // error at call time, not a harness crash.
    await writeFile(
      join(dir, WEB_TOOLS_PACKAGE_JSON_FILENAME),
      WEB_TOOLS_PACKAGE_JSON,
      "utf-8"
    );
    return target;
  } catch {
    return undefined;
  }
};

// Compares the installed manifest's `version` to `WEB_TOOLS_SDK_VERSION` rather
// than merely testing for the manifest's existence: after the pinned version is
// bumped, a stale on-disk SDK must NOT count as "installed", or the upgrade
// would be silently skipped and web search would keep using an incompatible old
// SDK. Any read/parse failure (missing manifest, malformed JSON, absent
// `version`) is treated as "not installed" so `ensureWebToolsSdk` re-runs
// `npm install --ignore-scripts` and self-heals.
const decodeManifestVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.optionalKey(Schema.String) })
  )
);

const webToolsSdkAlreadyInstalled = async (
  extensionDir: string
): Promise<boolean> => {
  const installedManifest = join(
    extensionDir,
    NODE_MODULES_DIR,
    WEB_TOOLS_SDK_PACKAGE,
    WEB_TOOLS_PACKAGE_JSON_FILENAME
  );
  try {
    const raw = await readFile(installedManifest, "utf-8");
    return Option.match(decodeManifestVersion(raw), {
      onNone: () => false,
      onSome: ({ version }) => version === WEB_TOOLS_SDK_VERSION,
    });
  } catch {
    return false;
  }
};

// Ensure `@openrouter/agent` resolves from a `node_modules` sibling of the
// materialized `web-tools.ts`. pi loads the extension via jiti and does NOT
// expose `@openrouter/agent` as a virtual module or alias, so the extension's
// dynamic `import("@openrouter/agent")` resolves against the filesystem, walking
// up from the extension file — a global install is invisible to it. We run a
// local `npm install --ignore-scripts` inside the web-tools dir at most once:
// if the package already resolves from there, this is a no-op. Best-effort —
// a failure leaves the SDK unresolved and degrades to a runtime tool error
// (the extension's import is already lazy + guarded), never a harness crash,
// so callers run this with `Effect.ignore`.
export const ensureWebToolsSdk = Effect.fn("PiHarness.ensureWebToolsSdk")(
  function* (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly extensionPath: string;
  }) {
    const extensionDir = dirname(input.extensionPath);
    if (
      yield* Effect.promise(() => webToolsSdkAlreadyInstalled(extensionDir))
    ) {
      return;
    }

    const npm = yield* Effect.promise(() => resolveNpm(input.env));
    const handle = yield* ChildProcess.make(
      npm,
      WEB_TOOLS_SDK_INSTALL_ARGS,
      {
        cwd: extensionDir,
        env: input.env,
        extendEnv: false,
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    yield* handle.exitCode;
  }
);

// Returns the extension path to pass to `pi --extension`, or undefined if
// materialization failed (in which case the caller omits the flag). Never
// throws: a failed SDK install degrades to a runtime tool error, not a crash.
export const setUpWebToolsExtension = async (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const extensionPath = await materializeWebToolsExtension(env);
  if (extensionPath !== undefined) {
    await Effect.runPromise(
      ensureWebToolsSdk({
        env,
        extensionPath,
      }).pipe(Effect.scoped, Effect.ignore, Effect.provide(NodeServicesLayer))
    );
  }
  return extensionPath;
};

export { materializeWebToolsExtension };
