import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import type { SimBehavior, SimDialect, SimError, SimJournalEntry } from "./behaviors.js";
import {
  anthropicBody,
  anthropicError,
  anthropicEvents,
  behaviorKind,
  googleBody,
  googleError,
  googleEvents,
  normalizeBehavior,
  openAiChatBody,
  openAiChatEvents,
  openAiError,
  responsesBody,
  responsesError,
  responsesEvents,
  sseBytes
} from "./provider-sim-wire.js";

type BehaviorSource = "queued" | "default";

type ResolvedBehavior = {
  behavior: SimBehavior;
  source: BehaviorSource;
};

class SimulatorState {
  readonly #queues = new Map<string, SimBehavior[]>();
  readonly #journal: SimJournalEntry[] = [];
  readonly #defaultCounts = new Map<string, number>();
  readonly #models = new Set<string>();
  #sequence = 0;
  #responseSequence = 0;

  constructor(models: readonly string[]) {
    for (const model of models) this.#models.add(model);
  }

  queue(model: string, behaviors: readonly SimBehavior[]): void {
    this.#models.add(model);
    const queue = this.#queues.get(model) ?? [];
    queue.push(...behaviors.map(normalizeBehavior));
    this.#queues.set(model, queue);
  }

  next(model: string, lastUserText: string): ResolvedBehavior {
    const queue = this.#queues.get(model);
    const queued = queue?.shift();
    if (queued !== undefined) return { behavior: queued, source: "queued" };
    const count = (this.#defaultCounts.get(model) ?? 0) + 1;
    this.#defaultCounts.set(model, count);
    const suffix = lastUserText.trim();
    return {
      behavior: normalizeBehavior({
        reply: `${model} default reply #${count}${suffix.length > 0 ? `: ${suffix}` : ""}`
      }),
      source: "default"
    };
  }

  record(entry: Omit<SimJournalEntry, "seq">): void {
    this.#sequence += 1;
    this.#journal.push({ ...entry, seq: this.#sequence });
  }

  journal(): SimJournalEntry[] {
    return this.#journal.map((entry) => ({ ...entry, request: { ...entry.request } }));
  }

  models(): string[] {
    return [...this.#models].sort();
  }

  nextId(prefix: string): string {
    this.#responseSequence += 1;
    return `${prefix}${this.#responseSequence}`;
  }

  reset(): void {
    this.#queues.clear();
    this.#journal.length = 0;
    this.#defaultCounts.clear();
    this.#sequence = 0;
    this.#responseSequence = 0;
  }
}

export type RunningProviderSimServer = {
  url: string;
  port: number;
  close(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jsonResponse(
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {}
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.byteLength),
    ...headers
  });
  response.end(bytes);
}

function lastOpenAiUserText(body: Record<string, unknown>): string {
  const messages = body.messages;
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
      .join("");
  }
  return "";
}

function lastAnthropicUserText(body: Record<string, unknown>): string {
  return lastOpenAiUserText(body);
}

function lastResponsesUserText(body: Record<string, unknown>): string {
  const input = body.input;
  if (typeof input === "string") return input;
  if (!Array.isArray(input)) return "";
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item) || item.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (!Array.isArray(item.content)) return "";
    return item.content
      .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
      .join("");
  }
  return "";
}

function lastGoogleUserText(body: Record<string, unknown>): string {
  const contents = body.contents;
  if (!Array.isArray(contents)) return "";
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index];
    if (!isRecord(content) || content.role !== "user" || !Array.isArray(content.parts)) continue;
    return content.parts
      .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
      .join("");
  }
  return "";
}

function errorForMissingTools(model: string): SimBehavior {
  return normalizeBehavior({
    error: {
      status: 400,
      code: "sim_tools_not_declared",
      error_type: "simulator_contract_error",
      message:
        `simulator: a tool_calls behavior was queued for ${JSON.stringify(model)} but the ` +
        "request declared no tools"
    }
  });
}

function errorHeaders(error: SimError): Record<string, string> {
  return error.retry_after === undefined || error.retry_after === null
    ? {}
    : { "retry-after": String(error.retry_after) };
}

async function delay(seconds: number | undefined): Promise<void> {
  if (seconds === undefined || seconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

async function writeSse(
  response: ServerResponse,
  bytes: Uint8Array,
  behavior: SimBehavior
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  const chunkSize = behavior.chunk_bytes ?? bytes.byteLength;
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  const limit =
    behavior.broken_stream === "truncate"
      ? Math.max(1, Math.ceil(chunks.length / 2))
      : chunks.length;
  for (let index = 0; index < limit; index += 1) {
    response.write(chunks[index]);
    await delay(behavior.chunk_delay_s);
  }
  if (behavior.broken_stream === "garbage") {
    response.write("data: {not-json}\n\n");
  }
  if (behavior.broken_stream === "truncate") {
    response.destroy();
    return;
  }
  response.end();
}

function resolveBehavior(input: {
  state: SimulatorState;
  dialect: SimDialect;
  path: string;
  model: string;
  stream: boolean;
  lastUserText: string;
  body: Record<string, unknown>;
}): SimBehavior {
  const resolved = input.state.next(input.model, input.lastUserText);
  const tools = input.body.tools;
  const behavior =
    (resolved.behavior.tool_calls?.length ?? 0) > 0 && (!Array.isArray(tools) || tools.length === 0)
      ? errorForMissingTools(input.model)
      : resolved.behavior;
  input.state.record({
    ts: Date.now() / 1000,
    dialect: input.dialect,
    path: input.path,
    model: input.model,
    stream: input.stream,
    source: resolved.source,
    kind: behaviorKind(behavior),
    status: behavior.error?.status ?? 200,
    request: input.body,
    reply_preview: (behavior.reply ?? "").slice(0, 200),
    tool_call_names: (behavior.tool_calls ?? []).map((call) => call.name),
    error_code: behavior.error?.code ?? null
  });
  return behavior;
}

export async function startProviderSimServer(
  options: { models?: readonly string[] } = {}
): Promise<RunningProviderSimServer> {
  const state = new SimulatorState(options.models ?? []);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        jsonResponse(response, { status: "ok", simulator: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/__sim/journal") {
        jsonResponse(response, { entries: state.journal() });
        return;
      }
      if (request.method === "GET" && ["/v1/models", "/models"].includes(url.pathname)) {
        const models = state.models();
        jsonResponse(response, {
          data: models.map((id) => ({ id })),
          models: models.map((slug) => ({ slug }))
        });
        return;
      }
      if (request.method !== "POST") {
        jsonResponse(response, { error: { message: `no route ${url.pathname}` } }, 404);
        return;
      }
      const body = await readJson(request);
      if (body === undefined) {
        jsonResponse(response, { error: { message: "invalid JSON body" } }, 400);
        return;
      }
      if (url.pathname === "/__sim/behaviors") {
        const model = body.model;
        const behaviors = body.behaviors;
        if (typeof model !== "string" || !Array.isArray(behaviors)) {
          jsonResponse(response, { error: { message: "expected {model, behaviors}" } }, 400);
          return;
        }
        const parsed = behaviors.filter(isRecord) as SimBehavior[];
        state.queue(model, parsed);
        jsonResponse(response, { status: "queued", model, count: parsed.length });
        return;
      }
      if (url.pathname === "/__sim/reset") {
        state.reset();
        jsonResponse(response, { status: "reset" });
        return;
      }

      if (["/v1/chat/completions", "/chat/completions"].includes(url.pathname)) {
        const model = typeof body.model === "string" ? body.model : "simulated";
        const stream = body.stream === true;
        const behavior = resolveBehavior({
          state,
          dialect: "openai-chat",
          path: url.pathname,
          model,
          stream,
          lastUserText: lastOpenAiUserText(body),
          body
        });
        await delay(behavior.delay_s);
        if (behavior.error !== undefined && behavior.error !== null) {
          jsonResponse(
            response,
            openAiError(behavior.error),
            behavior.error.status ?? 500,
            errorHeaders(behavior.error)
          );
          return;
        }
        const id = state.nextId("chatcmpl_sim_");
        if (stream) {
          const includeUsage =
            isRecord(body.stream_options) && body.stream_options.include_usage === true;
          await writeSse(
            response,
            sseBytes(openAiChatEvents(model, behavior, id, includeUsage), true),
            behavior
          );
        } else {
          jsonResponse(response, openAiChatBody(model, behavior, id));
        }
        return;
      }

      if (["/v1/messages", "/messages"].includes(url.pathname)) {
        const model = typeof body.model === "string" ? body.model : "simulated";
        const stream = body.stream === true;
        const behavior = resolveBehavior({
          state,
          dialect: "anthropic-messages",
          path: url.pathname,
          model,
          stream,
          lastUserText: lastAnthropicUserText(body),
          body
        });
        await delay(behavior.delay_s);
        if (behavior.error !== undefined && behavior.error !== null) {
          jsonResponse(
            response,
            anthropicError(behavior.error),
            behavior.error.status ?? 500,
            errorHeaders(behavior.error)
          );
          return;
        }
        const id = state.nextId("msg_sim_");
        if (stream) {
          await writeSse(response, sseBytes(anthropicEvents(model, behavior, id)), behavior);
        } else {
          jsonResponse(response, anthropicBody(model, behavior, id));
        }
        return;
      }

      if (["/v1/responses", "/responses"].includes(url.pathname)) {
        const model = typeof body.model === "string" ? body.model : "simulated";
        const stream = body.stream === true;
        const behavior = resolveBehavior({
          state,
          dialect: "openai-responses",
          path: url.pathname,
          model,
          stream,
          lastUserText: lastResponsesUserText(body),
          body
        });
        await delay(behavior.delay_s);
        if (behavior.error !== undefined && behavior.error !== null) {
          jsonResponse(
            response,
            responsesError(behavior.error),
            behavior.error.status ?? 500,
            errorHeaders(behavior.error)
          );
          return;
        }
        const id = state.nextId("resp_sim_");
        if (stream) {
          await writeSse(response, sseBytes(responsesEvents(model, behavior, id)), behavior);
        } else {
          jsonResponse(response, responsesBody(model, behavior, id));
        }
        return;
      }

      const google = url.pathname.match(
        /^\/(?:v1beta|v1)\/models\/([^:]+):(generateContent|streamGenerateContent)$/
      );
      if (google !== null) {
        const model = decodeURIComponent(google[1]!);
        const stream = google[2] === "streamGenerateContent";
        const behavior = resolveBehavior({
          state,
          dialect: "google-generate",
          path: url.pathname,
          model,
          stream,
          lastUserText: lastGoogleUserText(body),
          body
        });
        await delay(behavior.delay_s);
        if (behavior.error !== undefined && behavior.error !== null) {
          jsonResponse(
            response,
            googleError(behavior.error),
            behavior.error.status ?? 500,
            errorHeaders(behavior.error)
          );
          return;
        }
        if (stream) {
          await writeSse(response, sseBytes(googleEvents(behavior)), behavior);
        } else {
          jsonResponse(response, googleBody(behavior));
        }
        return;
      }

      jsonResponse(response, { error: { message: `no route ${url.pathname}` } }, 404);
    })().catch((error) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      jsonResponse(
        response,
        { error: { message: error instanceof Error ? error.message : String(error) } },
        500
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("provider simulator did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      })
  };
}
