# T3 Code on a RouteKit gateway

The repository provides an operator deployment for a durable, per-user T3 Code
server on a **macOS** host. It is intentionally a repository script rather
than a published `routekit t3` command.

```sh
pnpm t3:deploy -- --ssh velum-mini --routekit local
# Or: the T3 host already has a configured RouteKit remote named gateway-prod.
pnpm t3:deploy -- --ssh t3-host --routekit-remote gateway-prod

# Add projects to this deployment's own T3 state.
pnpm t3:deploy -- --ssh velum-mini --routekit local \
  --project /Users/alen/Documents/Development/routekit

pnpm t3:destroy -- --ssh velum-mini
```

## What it creates

For the default deployment ID, the target receives only these deployment-owned
resources:

- `~/Library/LaunchAgents/com.velum.routekit.t3.default.plist`;
- `~/.routekit/t3/default/run-t3.sh` and its launch logs;
- an isolated T3 data directory at `~/.routekit/t3/default/data`;
- a private, no-secret manifest at
  `~/.routekit/t3/deployments/default.json`;
- two named RouteKit **data-plane** service tokens;
- two matching macOS Keychain records under service `routekit-t3`.

The LaunchAgent listens only on `127.0.0.1:3774` by default. Use `--port` to
select another loopback port. A port that is already in use fails safely. The
deployment never adopts or replaces an existing listener; use a different port
instead.

The T3 base directory is deliberately separate from `~/.t3`, but Codex and
Claude Code use their normal homes (`~/.codex` and `~/.claude`). That retains
all existing MCPs, skills, client settings, auth, histories, and project
configuration. It is not an ephemeral harness installation.

The isolated T3 data directory receives an initial no-secret `settings.json`
that enables normal Codex and Claude providers, points them at those normal
harness homes, and adds the current RouteKit catalog as T3 model choices.
Codex also discovers its generated RouteKit catalog through the app server.
Claude entries use RouteKit's native `anthropic.routekit.<route>` IDs. The
script never edits `~/.t3`; if a user later changes this deployment's T3
settings, it will not overwrite those edits and instead fails if they no longer
configure both RouteKit harnesses.

## Preconditions

On the target, RouteKit must already be configured, running, healthy, and have
a nonempty live catalog. Codex and Claude Code must already be installed. The
script checks these facts before changing anything and never configures
providers, accounts, or RouteKit remotes.

For `--routekit-remote`, the named remote must already exist in the T3 host's
RouteKit remote registry. The script does not add, activate, edit, or remove a
remote. RouteKit service-token commands honor the selected named remote.

T3 is pinned to `0.0.31`. If T3 is absent, deployment installs that exact global
package. A different existing T3 version fails unless the operator explicitly
passes both `--upgrade-t3 --yes`. Destroy never uninstalls the global T3 package.

## Harness integration and credentials

The deployment validates an existing RouteKit Codex/Claude integration and
leaves it alone. If neither integration exists, it uses:

```sh
routekit codex install --no-token
routekit claude install --no-token
```

`--no-token` writes only RouteKit-owned client configuration: it never issues,
rotates, revokes, persists, or registers a native client credential. The
deployment then issues separate, exactly-labelled service tokens and stores the
plaintext only in Keychain. Each new deployment adds a cryptographic ownership
nonce to its labels, so interrupted-deployment recovery cannot mistake a
user-created token for one of its own. The launch wrapper retrieves those
tokens at start.

On a macOS SSH target, `security` normally defaults to the System keychain and
cannot access the logged-in user's login keychain. The deployment uses a
short-lived, GUI-domain LaunchAgent with a one-shot loopback capability solely
to add, read, or delete its own Keychain record. The temporary script, plist,
launchd arguments, result file, and deployment manifest contain no gateway
token; the bridge is unloaded and removed before each operation returns.

Codex needs its RouteKit model provider selected when T3 starts `codex
app-server`. The script reads the RouteKit-generated `routekit` profile and
sets T3's documented `T3CODE_CODEX_LAUNCH_ARGS` override with the generated
model, provider, and model-catalog values. Claude receives the same deployment
credential as `ANTHROPIC_AUTH_TOKEN` plus the RouteKit `ANTHROPIC_BASE_URL`.
No token is written to a Codex, Claude, T3, shell, plist, or manifest file.

An existing RouteKit config block without the matching native integration
registry entry is treated as manual/untracked and deployment stops without
modifying it. This prevents accidental takeover of a hand-managed setup.

## Verification

Deployment verifies, without submitting an inference request:

1. the selected RouteKit daemon is healthy and has live models;
2. Codex and Claude binaries execute their version commands;
3. T3 starts through the new LaunchAgent and answers `GET /health` on loopback;
4. each deployment-specific token can list models on the RouteKit gateway.

Those checks prove the installation, service credential, gateway, and T3
startup paths. They deliberately do not send a billed model request. Run a
normal T3 session after deploy when you want an end-to-end provider inference.

## Destruction safety

`pnpm t3:destroy` removes only assets recorded in the manifest after proving
all of the following:

- the wrapper and plist still hash exactly to the manifest contents;
- a Keychain entry still hashes to its deployment-issued token;
- the RouteKit token ID, label, and `createdBy` value exactly match the
  manifest.

A mismatch stops with no destructive action. Destroy never runs RouteKit config
init/import/migrate, provider/account mutations, remote add/remove, native
integration uninstall, `routekit stop`, or `npm uninstall`. It keeps the
RouteKit configuration and daemon, all Codex/Claude configuration, `~/.t3`,
the isolated T3 data/projects/sessions, logs, and the global T3 package. The
manifest remains as a destroyed ownership receipt so a later deploy can safely
recognize a RouteKit integration it originally created.

Interrupted deployments write a staging manifest before issuing a token. A
retry can revoke only exactly-labelled staging tokens and remove only
hash-verified deployment assets; it still never removes harness integration
configuration.
