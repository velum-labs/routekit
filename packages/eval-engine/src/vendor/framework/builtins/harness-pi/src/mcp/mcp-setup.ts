import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { layer as NodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Effect, Option, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";

import { resolveNpm } from "../harness/bun-resolution.ts";
import { resolvePiAgentDir } from "../openrouter-attribution/openrouter-attribution.ts";

// The MCP extension source, embedded as text so it travels INSIDE a compiled
// single-file binary (an on-disk sibling .ts would not exist at runtime in a
// compiled CLI). At spawn we materialize this to a real file and hand that
// path to the external `pi` process via `--extension`. Mirrors the `.ts.txt`
// embed convention used by the web-tools extension. Each `.ts.txt` twin is
// kept byte-identical to its real typechecked/linted source by the embed
// test. The extension imports the `mcp-config.ts` sibling relatively, so both
// are materialized side-by-side (like web-tools + web-tools-ssrf).
import mcpConfigSource from "./mcp-config.ts.txt";
import mcpExtensionSource from "./mcp-extension.ts.txt";

const MCP_DIR = "mcp";
const MCP_FILENAME = "mcp-extension.ts";
const MCP_CONFIG_FILENAME = "mcp-config.ts";
const MCP_PACKAGE_JSON_FILENAME = "package.json";
const NODE_MODULES_DIR = "node_modules";
// The MCP extension dynamically imports `@modelcontextprotocol/sdk` (the MCP
// client). Pinned to the exact version the extension typechecks against (the
// package's devDependency); bump in lockstep with the devDependency.
const MCP_SDK_PACKAGE = "@modelcontextprotocol/sdk";
const MCP_SDK_VERSION = "1.29.0";
// A local `npm install --ignore-scripts` inside the materialized mcp dir, so
// the SDK lands in a `node_modules` on the extension file's resolution
// walk-up path. Runs at most once per dir (gated on whether the package
// already resolves there). The package.json written below already pins the
// spec, so this install has no extra package arguments.
const MCP_SDK_INSTALL_ARGS = ["install", "--ignore-scripts"] as const;
// A minimal `package.json` written alongside `mcp-extension.ts` so the dir is
// a genuine project root: it gives `npm install` an anchor and gives jiti's
// filesystem resolution a `node_modules` to walk up into. `private` +
// `type: module` mirror the extension's ESM dynamic import; the declared
// dependency pins the SDK to the same version as the compiled-in extension.
const MCP_PACKAGE_JSON = `${JSON.stringify(
  {
    dependencies: { [MCP_SDK_PACKAGE]: MCP_SDK_VERSION },
    name: "ori-pi-mcp",
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
// `--extension` is honored even under `--no-extensions`, so the built-in MCP
// tools are always available with no per-workspace setup. Best-effort: a write
// failure must not block the run, so the caller treats a missing path as "skip
// the flag".
const materializeMcpExtension = async (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const dir = join(resolvePiAgentDir(env), MCP_DIR);
  const target = join(dir, MCP_FILENAME);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(target, mcpExtensionSource, "utf-8");
    // The config/decoder sibling the extension imports relatively; jiti resolves
    // it from this on-disk path. Written before the flag is handed back so the
    // relative import never dangles.
    await writeFile(join(dir, MCP_CONFIG_FILENAME), mcpConfigSource, "utf-8");
    // Write a package.json anchor so the dir is a project root: it gives
    // jiti's filesystem resolution a node_modules to walk up into and gives a
    // local `npm install` an anchor. Best-effort — a missing anchor only means
    // the SDK install below has no project root, which surfaces as a tool
    // error at call time, not a harness crash.
    await writeFile(
      join(dir, MCP_PACKAGE_JSON_FILENAME),
      MCP_PACKAGE_JSON,
      "utf-8"
    );
    return target;
  } catch {
    return undefined;
  }
};

// Compares the installed manifest's `version` to `MCP_SDK_VERSION` rather than
// merely testing for the manifest's existence: after the pinned version is
// bumped, a stale on-disk SDK must NOT count as "installed", or the upgrade
// would be silently skipped and the MCP client would keep using an incompatible
// old SDK. Any read/parse failure (missing manifest, malformed JSON, absent
// `version`) is treated as "not installed" so `ensureMcpSdk` re-runs
// `npm install --ignore-scripts` and self-heals.
const decodeManifestVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.optionalKey(Schema.String) })
  )
);

const mcpSdkAlreadyInstalled = async (
  extensionDir: string
): Promise<boolean> => {
  const installedManifest = join(
    extensionDir,
    NODE_MODULES_DIR,
    MCP_SDK_PACKAGE,
    MCP_PACKAGE_JSON_FILENAME
  );
  try {
    const raw = await readFile(installedManifest, "utf-8");
    return Option.match(decodeManifestVersion(raw), {
      onNone: () => false,
      onSome: ({ version }) => version === MCP_SDK_VERSION,
    });
  } catch {
    return false;
  }
};

// Ensure `@modelcontextprotocol/sdk` resolves from a `node_modules` sibling of
// the materialized `mcp-extension.ts`. pi loads the extension via jiti and does
// NOT expose the SDK as a virtual module or alias, so the extension's dynamic
// `import("@modelcontextprotocol/sdk")` resolves against the filesystem, walking
// up from the extension file — a global install is invisible to it. We run a
// local `npm install --ignore-scripts` inside the mcp dir at most once: if the
// package already resolves from there, this is a no-op. Best-effort — a failure
// leaves the SDK unresolved and degrades to a runtime tool error (the
// extension's import is already lazy + guarded), never a harness crash, so
// callers run this with `Effect.ignore`.
export const ensureMcpSdk = Effect.fn("PiHarness.ensureMcpSdk")(
  function* (input: {
    readonly env: NodeJS.ProcessEnv;
    readonly extensionPath: string;
  }) {
    const extensionDir = dirname(input.extensionPath);
    if (yield* Effect.promise(() => mcpSdkAlreadyInstalled(extensionDir))) {
      return;
    }

    const npm = yield* Effect.promise(() => resolveNpm(input.env));
    const handle = yield* ChildProcess.make(npm, MCP_SDK_INSTALL_ARGS, {
      cwd: extensionDir,
      env: input.env,
      extendEnv: false,
      stderr: "pipe",
      stdout: "pipe",
    });
    yield* handle.exitCode;
  }
);

// Returns the extension path to pass to `pi --extension`, or undefined if
// materialization failed (in which case the caller omits the flag). Never
// throws: a failed SDK install degrades to a runtime tool error, not a crash.
export const setUpMcpExtension = async (
  env: NodeJS.ProcessEnv
): Promise<string | undefined> => {
  const extensionPath = await materializeMcpExtension(env);
  if (extensionPath !== undefined) {
    await Effect.runPromise(
      ensureMcpSdk({
        env,
        extensionPath,
      }).pipe(Effect.scoped, Effect.ignore, Effect.provide(NodeServicesLayer))
    );
  }
  return extensionPath;
};

export { materializeMcpExtension };
