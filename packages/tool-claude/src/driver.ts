import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKMessage
} from "@anthropic-ai/claude-agent-sdk";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalDecision,
  ApprovalPolicy,
  DriverContext,
  HarnessDriver,
  HarnessEvent,
  HarnessInstance,
  HarnessRequestType,
  HarnessStatus,
  ResumeCursor,
  SessionHandle,
  SessionTurnInput,
  StartSessionOptions
} from "@velum-labs/routekit-harness-core";

import {
  AsyncChannel,
  asHarnessError,
  buildChildEnv,
  createCachedHarnessDriver,
  DEFAULT_AUTOMATION_APPROVAL_POLICY,
  decideApproval,
  HarnessError,
  nowIso,
  PendingRequests,
  probeCliVersion,
  resolveDriverEnv,
  resumeStringField,
  SessionResourceRegistry,
  SingleFlightTurnController
} from "@velum-labs/routekit-harness-core";
import { z } from "zod";

const RESUME_CURSOR_VERSION = 1;
const DEFAULT_COMMAND = "claude";

const AUTH_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL"
] as const;

export const claudeDriverConfigSchema = z.object({
  command: z.string().default(DEFAULT_COMMAND),
  model: z.string().optional(),
  /** Anthropic-dialect base URL claude's model calls route to (the gateway). */
  baseUrl: z.string().optional(),
  /** Extra credential env var names forwarded into the claude child. */
  credentialEnvNames: z.array(z.string()).default([])
});

export type ClaudeDriverConfig = z.infer<typeof claudeDriverConfigSchema>;

/**
 * The Agent SDK `query` function shape, isolated as a seam so tests can inject
 * a scripted transport instead of spawning the real `claude` binary (whose
 * control protocol is impractical to fake).
 */
export type ClaudeQueryFn = (params: { prompt: string; options: Options }) => Query;

export type ClaudeDriverOptions = {
  queryFn?: ClaudeQueryFn;
};

/**
 * The canonical approval request type for a claude tool name. Note `Task`
 * (Claude's sub-agent tool) deliberately lands in the generic `tool_approval`
 * bucket: under the automation default policy (`autoApprove: "all"`) it is
 * auto-accepted, so unattended runs can parallelize with same-model sub-agents,
 * while stricter policies (`edits`/`none`) still surface it like any tool.
 */
function requestTypeForTool(toolName: string): HarnessRequestType {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("execute")) return "exec_command_approval";
  if (lower.includes("edit") || lower.includes("write")) return "file_change_approval";
  if (lower.includes("read")) return "file_read_approval";
  return "tool_approval";
}

type ContentBlock = {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
};

class ClaudeSession implements SessionHandle {
  readonly #kind = "claude_code" as const;
  readonly #config: ClaudeDriverConfig;
  readonly #context: DriverContext | undefined;
  readonly #cwd: string;
  readonly #model: string | undefined;
  readonly #reasoning: StartSessionOptions["reasoning"];
  readonly #approvalPolicy: ApprovalPolicy;
  readonly #pending = new PendingRequests();
  #sessionId: string;
  #activeQuery: Query | undefined;
  #stopped = false;
  readonly #turns = new SingleFlightTurnController();

  readonly #queryFn: ClaudeQueryFn;

  constructor(input: {
    config: ClaudeDriverConfig;
    context: DriverContext | undefined;
    options: StartSessionOptions;
    queryFn: ClaudeQueryFn;
  }) {
    this.#config = input.config;
    this.#context = input.context;
    this.#cwd = input.options.cwd;
    this.#model = input.options.model ?? input.config.model;
    this.#reasoning = input.options.reasoning;
    this.#approvalPolicy = input.options.approvalPolicy ?? DEFAULT_AUTOMATION_APPROVAL_POLICY;
    this.#sessionId = resumeSessionId(input.options.resume) ?? "claude:pending";
    this.#queryFn = input.queryFn;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  #canUseTool(): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      const requestType = requestTypeForTool(toolName);
      const auto = decideApproval(this.#approvalPolicy, requestType);
      const decision = auto ?? (await this.#surface(toolName, requestType, options.signal));
      if (decision === "decline" || decision === "cancel") {
        return { behavior: "deny", message: `denied by approval policy: ${toolName}` };
      }
      return {
        behavior: "allow",
        updatedInput: input,
        ...(decision === "acceptForSession" && options.suggestions !== undefined
          ? { updatedPermissions: options.suggestions }
          : {})
      };
    };
  }

  #channel: AsyncChannel<HarnessEvent> | undefined;

  async #surface(
    toolName: string,
    requestType: HarnessRequestType,
    signal: AbortSignal
  ): Promise<ApprovalDecision> {
    const request = this.#pending.open({ requestType, detail: toolName });
    this.#emit({
      kind: this.#kind,
      sessionId: this.#sessionId,
      at: nowIso(),
      type: "request.opened",
      requestId: request.requestId,
      requestType,
      detail: toolName,
      raw: { source: "claude.canUseTool" }
    });
    const decision = await Promise.race([
      request.decision,
      new Promise<ApprovalDecision>((resolve) => {
        if (signal.aborted) resolve("cancel");
        else signal.addEventListener("abort", () => resolve("cancel"), { once: true });
      })
    ]);
    this.#emit({
      kind: this.#kind,
      sessionId: this.#sessionId,
      at: nowIso(),
      type: "request.resolved",
      requestId: request.requestId,
      decision,
      raw: { source: "claude.canUseTool" }
    });
    return decision;
  }

  #emit(event: HarnessEvent): void {
    this.#channel?.push(event);
  }

  async *sendTurn(input: SessionTurnInput): AsyncIterable<HarnessEvent> {
    if (this.#stopped) throw new HarnessError("session_closed", "claude session is stopped");
    const turn = this.#turns.start(input.signal);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(turn.signal.reason);
    if (turn.signal.aborted) onAbort();
    else turn.signal.addEventListener("abort", onAbort, { once: true });
    const channel = new AsyncChannel<HarnessEvent>({
      capacity: 256,
      onConsumerReturn: () => turn.dispose()
    });
    this.#channel = channel;
    const turnId = `${this.#sessionId}:turn:${Date.now()}`;
    // turn.started is emitted from mapMessage once system/init fixes the real
    // session id, so it (and every later event) carries the final id.
    let q: Query | undefined;
    let pump: Promise<void> | undefined;
    let done = false;
    try {
      const resume = this.#sessionId !== "claude:pending" ? this.#sessionId : undefined;
      const reasoning = input.reasoning ?? this.#reasoning;
      const options: Options = {
        cwd: this.#cwd,
        pathToClaudeCodeExecutable: this.#config.command,
        // The gateway carries this cursor across front-door turns. Make the
        // persistence requirement explicit: SDK defaults have changed across
        // releases and an ephemeral session id cannot be resumed by the next
        // candidate process.
        persistSession: true,
        permissionMode: "default",
        canUseTool: this.#canUseTool(),
        abortController: controller,
        env: this.#childEnv(),
        ...(this.#model !== undefined ? { model: this.#model } : {}),
        ...(reasoning?.mode === "effort"
          ? {
              thinking: { type: "adaptive" },
              effort: reasoning.effort as NonNullable<Options["effort"]>
            }
          : reasoning?.mode === "budget"
            ? {
                thinking: {
                  type: "enabled",
                  budgetTokens: reasoning.budgetTokens
                }
              }
            : reasoning?.mode === "adaptive"
              ? { thinking: { type: "adaptive" } }
              : reasoning?.mode === "disabled"
                ? { thinking: { type: "disabled" } }
                : {}),
        ...(resume !== undefined ? { resume } : {})
      };

      q = this.#queryFn({ prompt: input.prompt, options });
      this.#activeQuery = q;
      pump = (async (): Promise<void> => {
        try {
          for await (const message of q as Query) {
            for (const event of this.#mapMessage(message, turnId)) channel.push(event);
          }
        } catch (error) {
          const base = { kind: this.#kind, sessionId: this.#sessionId, at: nowIso(), turnId };
          if (controller.signal.aborted) {
            channel.push({ ...base, type: "turn.completed", endReason: "aborted" });
          } else {
            const harnessError = asHarnessError(error);
            channel.push({
              ...base,
              type: "turn.failed",
              errorCode: harnessError.code,
              message: harnessError.message
            });
          }
        } finally {
          done = true;
          channel.close();
        }
      })();

      yield* channel;
      await pump;
    } finally {
      if (done) turn.complete();
      turn.dispose();
      turn.signal.removeEventListener("abort", onAbort);
      if (!done) await q?.interrupt().catch(() => undefined);
      channel.close();
      this.#channel = undefined;
      this.#activeQuery = undefined;
    }
  }

  *#mapMessage(message: SDKMessage, turnId: string): Generator<HarnessEvent> {
    const base = { kind: this.#kind, sessionId: this.#sessionId, at: nowIso(), turnId };
    const raw = { source: "claude.sdk.message", method: message.type };
    if (message.type === "system" && message.subtype === "init") {
      const resumed =
        this.#sessionId !== "claude:pending" && this.#sessionId === message.session_id;
      this.#sessionId = message.session_id;
      yield {
        kind: this.#kind,
        sessionId: this.#sessionId,
        at: nowIso(),
        type: "session.started",
        resumed,
        raw
      };
      // Bracket the turn now that the real session id is known, so turn.started
      // and every subsequent event carry the final id.
      yield {
        kind: this.#kind,
        sessionId: this.#sessionId,
        at: nowIso(),
        turnId,
        type: "turn.started"
      };
      return;
    }
    if (message.type === "assistant") {
      const content = (message.message as { content?: ContentBlock[] }).content ?? [];
      for (const block of content) {
        if (block.type === "text" && block.text !== undefined && block.text.length > 0) {
          yield { ...base, type: "content.delta", stream: "assistant_text", text: block.text, raw };
        } else if (block.type === "thinking" && block.thinking !== undefined) {
          yield {
            ...base,
            type: "content.delta",
            stream: "reasoning_text",
            text: block.thinking,
            raw
          };
        } else if (block.type === "tool_use") {
          yield {
            ...base,
            type: "tool.call",
            name: block.name ?? "tool",
            ...(block.input !== undefined ? { input: block.input as never } : {}),
            raw
          };
        }
      }
      return;
    }
    if (message.type === "result") {
      const endReason = message.subtype === "success" ? "completed" : "error";
      yield {
        ...base,
        type: "turn.completed",
        endReason,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens
        },
        raw
      };
      return;
    }
  }

  #childEnv(): Record<string, string> {
    return buildChildEnv({
      base: resolveDriverEnv(this.#context),
      allow: [...AUTH_ENV_NAMES, ...this.#config.credentialEnvNames, /^CLAUDE_/],
      ...(this.#config.baseUrl !== undefined
        ? { extra: { ANTHROPIC_BASE_URL: this.#config.baseUrl } }
        : {})
    });
  }

  async respondToRequest(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (!this.#pending.resolve(requestId, decision)) {
      throw new HarnessError("protocol_parse", `unknown pending request ${requestId}`);
    }
  }

  async interrupt(): Promise<void> {
    this.#turns.interrupt();
    this.#pending.settleAll("cancel");
    await this.#activeQuery?.interrupt().catch(() => undefined);
  }

  resumeCursor(): ResumeCursor | undefined {
    if (this.#sessionId === "claude:pending") return undefined;
    return {
      version: RESUME_CURSOR_VERSION,
      kind: this.#kind,
      data: { sessionId: this.#sessionId }
    };
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#turns.interrupt(new Error("claude session stopped"));
    this.#pending.settleAll("cancel");
    await this.#activeQuery?.interrupt().catch(() => undefined);
  }
}

function resumeSessionId(resume: ResumeCursor | undefined): string | undefined {
  return resumeStringField(resume, "claude_code", "sessionId");
}

class ClaudeInstance implements HarnessInstance {
  readonly kind = "claude_code" as const;
  readonly #config: ClaudeDriverConfig;
  readonly #context: DriverContext | undefined;
  readonly #status: HarnessStatus;
  readonly #queryFn: ClaudeQueryFn;
  readonly #sessions = new SessionResourceRegistry();

  constructor(input: {
    config: ClaudeDriverConfig;
    context: DriverContext | undefined;
    status: HarnessStatus;
    queryFn: ClaudeQueryFn;
  }) {
    this.#config = input.config;
    this.#context = input.context;
    this.#status = input.status;
    this.#queryFn = input.queryFn;
  }

  status(): HarnessStatus {
    return this.#status;
  }

  async startSession(options: StartSessionOptions): Promise<SessionHandle> {
    this.#sessions.assertOpen();
    const session = new ClaudeSession({
      config: this.#config,
      context: this.#context,
      options,
      queryFn: this.#queryFn
    });
    return this.#sessions.manage(session);
  }

  async dispose(): Promise<void> {
    await this.#sessions.dispose();
  }
}

/** Probe the claude CLI: version via `claude --version`, auth from credential env. */
async function probeClaude(
  config: ClaudeDriverConfig,
  context: DriverContext | undefined
): Promise<HarnessStatus> {
  const sourceEnv = resolveDriverEnv(context);
  const env = buildChildEnv({ base: sourceEnv, allow: [...AUTH_ENV_NAMES, /^CLAUDE_/] });
  const hasCredential = AUTH_ENV_NAMES.some((name) => (sourceEnv[name]?.length ?? 0) > 0);
  return probeCliVersion({
    kind: "claude_code",
    command: config.command,
    cliName: "claude",
    env,
    auth: {
      status: hasCredential ? "authenticated" : "unknown",
      ...(hasCredential ? {} : { detail: "No API key in env; claude may use its own login." })
    },
    failureAuth: { status: "unknown" },
    notInstalledMessage: `Claude CLI "${config.command}" was not found on PATH.`
  });
}

export function createClaudeDriver(
  options: ClaudeDriverOptions = {}
): HarnessDriver<ClaudeDriverConfig> {
  const queryFn = options.queryFn ?? (query as ClaudeQueryFn);
  return createCachedHarnessDriver({
    kind: "claude_code",
    configSchema: claudeDriverConfigSchema,
    probeConfig: () => claudeDriverConfigSchema.parse({}),
    probeStatus: probeClaude,
    createInstance: (config, context, status) =>
      new ClaudeInstance({ config, context, status, queryFn })
  });
}
