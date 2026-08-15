import type { Schema } from "effect";

import type {
  AgentRuntimeEvent,
  ElicitationResolvedAction,
  PermissionOptionKind,
} from "./agent-event.ts";
import type { ApiFeatureContext } from "./api.ts";
import type { CommandRouter } from "./command-dispatch.ts";
import type { FeatureConfig } from "./feature-config.ts";
import type { FeatureLogger } from "./feature-logger.ts";
import type { AgentParameters } from "./parameters.ts";
import type { ReasoningEffort } from "./reasoning-effort.ts";
import type { StoreResolver } from "./stores.ts";

export interface ChatTurnInput<A = unknown> {
  /**
   * Per-turn environment variables threaded down to the spawned agent's
   * process (merged over the harness's base env). Lets a chat feature pass
   * runtime context — e.g. the originating Slack channel/thread/user — to the
   * agent's tools as real env vars instead of injecting it into the prompt.
   */
  readonly env?: Record<string, string | undefined> | undefined;
  readonly parameters?: AgentParameters | undefined;
  /**
   * Force a rollover before this turn (the /compact fallback for harnesses
   * without native compaction): the daemon summarizes the resumed session and
   * re-seeds a fresh one. Ignored without a sessionId.
   */
  readonly forceRollover?: boolean | undefined;
  readonly harness?: string | undefined;
  readonly model?: string | null | undefined;
  /**
   * Optional structured-output contract. When set, the run is asked to return a
   * JSON object matching this schema; the schema is threaded to the harness so it
   * can instruct the model accordingly (RFC 0002 schedule.md).
   */
  readonly output?: Schema.ConstraintDecoder<A> | undefined;
  /**
   * Partial work captured from a turn the user interrupted to steer (RFC 0005 run steering).
   * When set, the runloop composes a bridge preamble ahead of {@link prompt} so
   * the redirected turn sees what the aborted turn had produced so far — a
   * harness-neutral hedge that does not depend on either binary's mid-turn
   * transcript-flush timing. Empty/whitespace values are ignored.
   */
  readonly priorPartial?: string | undefined;
  readonly prompt: string;
  readonly sessionId?: string | undefined;
  /** Optional AbortSignal — aborts the underlying fetch so a stalled turn is interrupted immediately. */
  readonly signal?: AbortSignal | undefined;
  readonly systemPrompt?: string | undefined;
}

export interface ChatSessionSummary {
  readonly completedTurns?: number | undefined;
  readonly failedTurns?: number | undefined;
  readonly lastEventType?: string | undefined;
  /**
   * The session this one was forked from (Fork Thread, RFC 0003). Present
   * only on forked sibling threads; absent on root threads. Lets a surface
   * render lineage and offer a jump back to the parent thread.
   */
  readonly parentSessionId?: string | undefined;
  readonly sessionId: string;
  readonly updatedAt?: string | undefined;
}

export interface PersistedChatSessionSummary {
  readonly completedTurns: number;
  readonly endedAt: string;
  readonly failedTurns: number;
  /** Derived from the session's most recent run prompt; absent when not recorded. */
  readonly latestPrompt?: string | undefined;
  readonly harness: string;
  /** Derived from the session's run context; absent when not recorded. */
  readonly model?: string | null | undefined;
  readonly sessionId: string;
  readonly startedAt: string;
}

/**
 * Start a new sibling thread from an existing one (Fork Thread, RFC 0003). The
 * daemon summarizes {@link parentSessionId}, mints a new session seeded with
 * that summary plus a lookup pointer, and streams the child's run — which runs
 * concurrently with the parent under the same daemon.
 */
export interface ForkThreadInput {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly parameters?: AgentParameters | undefined;
  readonly harness?: string | undefined;
  readonly model?: string | null | undefined;
  readonly parentSessionId: string;
  /** The task the forked thread should carry out. */
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
  readonly systemPrompt?: string | undefined;
}

/**
 * One row a chat surface can offer in its input autocomplete: a feature
 * command or skill, named without the leading `/` (the surface adds its own
 * invocation syntax). `description` is the human line rendered next to the
 * name (RFC 0002 command.md / skill.md).
 */
export interface ChatSuggestion {
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly name: string;
}

/** Passive update notice the host may inject for chat surfaces (RFC 0004 auto-update.md). */
export interface UpdateNotice {
  readonly currentVersion: string | null;
  readonly latestVersion: string;
  readonly severity: "major" | "minor" | "patch";
}

export type ChatInteractionResponse =
  | {
      readonly correlationId: string;
      readonly kind: "permission";
      readonly response:
        | { readonly outcome: "cancelled" }
        | {
            readonly optionKind: PermissionOptionKind;
            readonly outcome: "selected";
          };
      readonly sessionId: string;
    }
  | {
      readonly correlationId: string;
      readonly kind: "elicitation";
      readonly response:
        | {
            readonly action: "accept";
            readonly content?: Readonly<
              Record<string, boolean | number | string | readonly string[]>
            >;
          }
        | {
            readonly action: Exclude<ElicitationResolvedAction, "accept">;
          };
      readonly sessionId: string;
    };

export interface Chat {
  /** Startup diagnostics rendered by the surface after it mounts. */
  readonly startupWarnings?: readonly string[] | undefined;
  /** Load the durable runtime events for the initially attached session. */
  readonly loadSessionEvents?: () => Promise<readonly AgentRuntimeEvent[]>;
  readonly loadSessionEventsById?: (
    sessionId: string
  ) => Promise<readonly AgentRuntimeEvent[]>;
  /**
   * The directory `routekit-eval tui`/`routekit-eval code` was launched in — the same value sent as
   * each turn's `cwd`. Surfaced so a chat surface can scope client-local UX
   * state (e.g. per-directory prompt-input history) to the project directory.
   * Optional so lightweight `Chat` mocks need not supply it.
   */
  readonly cwd?: string | undefined;
  /**
   * Pre-agent slash-command router (RFC 0002 command.md). The host injects it
   * when the workspace has `command` contributions; a surface calls
   * `commands.dispatch({ line, via })` on inbound input and, unless the result
   * is `not-a-command`, renders it instead of starting an agent turn.
   * Optional so lightweight `Chat` mocks and command-free workspaces need none.
   */
  readonly commands?: CommandRouter | undefined;
  /**
   * User-editable configuration access (Feature Configuration Access, RFC 0005).
   * The host injects it so a chat contribution reads and writes its own block of
   * the shared `config.json`. Unlike {@link stores}, it is client-local: it acts
   * on the `config.json` files on the machine the surface runs on, never a
   * daemon, so a preference follows the terminal the user is attached to and
   * reflects a hand-edited file immediately. The host owns the file mechanics
   * (scopes, local-over-global merge, resilience, merge-preserving write); the
   * feature owns its block's schema, defaults, and environment overlay. Optional
   * only so lightweight `Chat` mocks need not supply it; the process-global
   * `import { config } from "routekit-eval/config"` is the equivalent for contribution code
   * with no `Chat` handle in scope, such as `start()`.
   */
  readonly config?: FeatureConfig | undefined;
  /**
   * Best-effort release-channel update check the host runs once on startup.
   * When it resolves to a notice, the surface may render a passive
   * "update available" hint; failures and opt-outs resolve to `null`. The
   * optional `signal` lets the surface abort the in-flight check (and its
   * underlying request) when it unmounts, so a quit never waits on the fetch.
   */
  readonly checkForUpdate?:
    | ((signal?: AbortSignal) => Promise<UpdateNotice | null>)
    | undefined;
  /** Default harness slug for turns when no in-session `/harness` pick is active. */
  readonly defaultHarness?: string | undefined;
  /** Default model slug shown in the footer when no per-turn override is set. */
  readonly defaultModel?: string | null | undefined;
  /** Built-in reasoning effort used when no remembered choice is set. */
  readonly defaultEffort?: ReasoningEffort | undefined;
  /**
   * Harness slug the user explicitly requested for this launch (e.g. the CLI's
   * `--harness` flag). When set, it takes precedence over any client-side
   * remembered selection; unset when the launch relied on defaults.
   */
  readonly harnessOverride?: string | undefined;
  /**
   * Model slug the user explicitly requested for this launch (e.g. the CLI's
   * `--model` flag). When set, it takes precedence over any client-side
   * remembered selection; unset when the launch relied on defaults.
   */
  readonly modelOverride?: string | null | undefined;
  /**
   * First prompt supplied with `--prompt`/`-p` or `--prompt-file <path>`; these
   * forms are mutually exclusive and there is no positional form (RFC 0004
   * code.md / tui.md). When set, the surface submits it as the first turn
   * automatically once it is ready, through the same path typed input takes: it
   * lands in prompt-input history on the same terms, and text naming a slash
   * command (`"/resume"`) runs that command rather than being sent to the
   * agent. Unset (or whitespace-only) leaves the composer idle. On a resumed launch it runs as
   * the next turn after the transcript replays. It waits for remembered
   * `/model` and `/harness` recall so the turn runs on the remembered harness,
   * but not for the catalog validation a remembered model needs, so that model
   * may only apply from the next turn.
   */
  readonly initialPrompt?: string | undefined;
  /**
   * True when the initially attached session is a fresh client-minted id the
   * runtime has not confirmed (a managed or draft launch), false for a resume
   * whose transcript is already established. Set by the launch path so a surface
   * asserts provenance from the source rather than reconstructing it from a
   * correlated capability (e.g. the presence of `loadSessionEvents`). Optional so
   * lightweight `Chat` mocks need not supply it; treated as non-provisional when
   * absent.
   */
  readonly initialSessionProvisional?: boolean;
  readonly initialSessionId: () => string | undefined;
  readonly listSessions: () => Promise<readonly ChatSessionSummary[]>;
  readonly listPersistedSessions?: () => Promise<
    readonly PersistedChatSessionSummary[]
  >;
  /** Diagnostic logger pre-scoped to the owning chat surface (RFC 0011). */
  readonly logger?: FeatureLogger | undefined;
  readonly sendMessage: (
    input: ChatTurnInput
  ) => AsyncIterable<AgentRuntimeEvent>;
  /** Submit one response to a live permission or elicitation request. */
  readonly respondInteraction?:
    | ((input: ChatInteractionResponse) => Promise<void>)
    | undefined;
  /**
   * Fork a new sibling thread (Fork Thread, RFC 0003) and stream the child's
   * run. Optional so lightweight `Chat` mocks need not supply it; a surface
   * should feature-detect before offering a fork affordance.
   */
  readonly forkThread?:
    | ((input: ForkThreadInput) => AsyncIterable<AgentRuntimeEvent>)
    | undefined;
  /**
   * Framework state store access (Feature State Store Access, RFC 0005). The
   * host injects it in both topologies: the in-process store when the surface
   * runs in-daemon (`routekit-eval start`), and a key-value client proxy when it runs in a
   * client process (`routekit-eval tui`). Optional only so lightweight `Chat` mocks need
   * not supply it; a surface that persists state uses this (or the process-global
   * `db` from `routekit-eval/state`) and MUST NOT open its own database.
   */
  readonly stores?: StoreResolver | undefined;
  /**
   * Dependency-gated access to another feature's `api.exports`. The host injects
   * the resolver for this surface in both in-daemon and client-process
   * topologies, like `stores`; it is optional for lightweight Chat mocks.
   */
  readonly use?: ApiFeatureContext["use"] | undefined;
  /**
   * Feature commands and skills for the surface's input autocomplete (RFC 0002
   * command.md / skill.md). The host builds it from boot registries and
   * suggestion-only built-ins; a surface renders each row's name and
   * description alongside its own built-in commands. Optional so lightweight
   * `Chat` mocks and workspaces with no commands or skills need none.
   */
  readonly suggestions?: readonly ChatSuggestion[] | undefined;
}

export interface ChatContribution {
  readonly name: string;
  /**
   * Starts the chat surface with the host-provided chat handle.
   */
  readonly start: (chat: Chat) => Promise<void>;
  readonly stop: () => Promise<void>;
  /**
   * Optional pre-render warmup hook. The host calls this synchronously and
   * fire-and-forget, as early as possible ahead of `start()`, so a surface can
   * kick off expensive async setup (e.g. warming a lazy module import graph)
   * while the host does its own serial pre-render work. A surface MUST NOT
   * throw synchronously from `warmup`; any async failure it swallows must
   * still be reported authoritatively by `start()`. Optional so a lightweight
   * chat contribution need not supply it.
   */
  readonly warmup?: (() => void) | undefined;
}
