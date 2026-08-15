import { Option, Result, Schema } from "effect";

import type { AgentRun, AgentRuntimeEvent } from "../../../../contracts/author/src/index.ts";

import { isAssistantTextDelta } from "../../../../contracts/author/src/index.ts";
import { makeReplayEventStream } from "../event/replay-stream.ts";

const NOTHING_BUFFERED = 0;
const MAX_REPAIR_ATTEMPTS = 1;

/** A factory for the run's underlying event stream (used for the repair retry). */
type AgentRunSource = (prompt: string) => AsyncIterable<AgentRuntimeEvent>;

interface MakeAgentRunOptions<A> {
  /** Observe every event as the run is drained — e.g. to record started session ids. */
  readonly onEvent?: ((event: AgentRuntimeEvent) => void) | undefined;
  /** The structured-output contract; when present, {@link AgentRun.output} decodes against it. */
  readonly output: Option.Option<Schema.ConstraintDecoder<A>>;
  /** The originating prompt, reused to compose a correction when a structured response fails validation. */
  readonly prompt: string;
  /** Starts the run's event stream. Called once eagerly, and again per repair attempt. */
  readonly source: AgentRunSource;
}

type DecodeResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly error: string; readonly ok: false };

// The schema instruction itself is re-applied by the harness because `output`
// is unchanged.
const composeRepairPrompt = (prompt: string, error: string): string =>
  `${prompt}\n\nYour previous response did not match the required JSON schema (${error}). Respond again with only a single JSON object that satisfies the schema.`;

const FENCE_PATTERN = /```(?:json)?\s*([\S\s]*?)\s*```/iu;

const tryParseJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const firstOpenBraceIndex = (text: string): number | undefined => {
  const objectIndex = text.indexOf("{");
  const arrayIndex = text.indexOf("[");
  if (objectIndex === -1) {
    return arrayIndex === -1 ? undefined : arrayIndex;
  }
  if (arrayIndex === -1) {
    return objectIndex;
  }
  return Math.min(objectIndex, arrayIndex);
};

interface JsonStringScanState {
  escaped: boolean;
  inString: boolean;
}

const consumedByStringState = (
  state: JsonStringScanState,
  char: string
): boolean => {
  if (state.escaped) {
    state.escaped = false;
    return true;
  }
  if (char === "\\") {
    state.escaped = true;
    return true;
  }
  if (char === '"') {
    state.inString = !state.inString;
    return true;
  }
  return state.inString;
};

const firstBalancedSpan = (text: string): string | undefined => {
  const openIndex = firstOpenBraceIndex(text);
  if (openIndex === undefined) {
    return undefined;
  }

  const open = text[openIndex];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  const scan: JsonStringScanState = {
    escaped: false,
    inString: false,
  };
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (consumedByStringState(scan, char)) {
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openIndex, index + 1);
      }
    }
  }
  return undefined;
};

/**
 * Pull a JSON value out of an assistant's free-form text: try the whole string,
 * then a fenced ```json block, then the first balanced object/array span. Returns
 * the parsed value, or `undefined` when nothing parses.
 */
const extractJsonValue = (text: string): unknown => {
  const trimmed = text.trim();
  if (trimmed.length === NOTHING_BUFFERED) {
    return undefined;
  }

  const direct = tryParseJson(trimmed);
  if (Option.isSome(direct)) {
    return direct.value;
  }

  const fenced = FENCE_PATTERN.exec(trimmed)?.[1];
  if (fenced !== undefined) {
    const parsed = tryParseJson(fenced.trim());
    if (Option.isSome(parsed)) {
      return parsed.value;
    }
  }

  const span = firstBalancedSpan(trimmed);
  if (span !== undefined) {
    const parsed = tryParseJson(span);
    if (Option.isSome(parsed)) {
      return parsed.value;
    }
  }

  return undefined;
};

const decodeStructuredOutput = <A>(
  schema: Schema.ConstraintDecoder<A>,
  text: string
): DecodeResult<A> => {
  const parsed = extractJsonValue(text);
  if (parsed === undefined) {
    return {
      error: "no JSON object was found in the response",
      ok: false,
    };
  }

  return Result.match(Schema.decodeUnknownResult(schema)(parsed), {
    onSuccess: (value): DecodeResult<A> => ({
      ok: true,
      value,
    }),
    onFailure: (error): DecodeResult<A> => ({
      error: error.message,
      ok: false,
    }),
  });
};

/**
 * Wrap a run's event stream in the author-facing {@link AgentRun} handle (RFC
 * 0002 schedule.md). The stream is drained eagerly into a
 * {@link makeReplayEventStream}
 * replay buffer so the run starts as soon as it is requested and any number of
 * consumers — a `for await`, a session-id tap, and `text()`/`output()` — each
 * observe the full sequence. That shared primitive is bounded (the buffer no
 * longer grows without limit on a long run) and cancellable (a consumer that
 * breaks early tells the underlying source to stop). `output()` reconstructs the
 * assistant's text, parses a JSON value out of it, and validates it against the
 * supplied schema, retrying once with a correction when validation fails.
 */
// `makeAgentRun` and `AgentRunHandle` are mutually recursive: the factory
// constructs the handle, and the handle's `output()` repair path calls back into
// `makeAgentRun`. Both references are deferred to call time (arrow/method bodies),
// so the cycle is runtime-safe and cannot be resolved by reordering.
const makeAgentRun = <A>(options: MakeAgentRunOptions<A>): AgentRun<A> =>
  // oxlint-disable-next-line no-use-before-define
  new AgentRunHandle(options);

// The agent run's replay buffer is bounded to this many un-consumed events. A
// single agent run's event volume is modest, so the ceiling only ever bites a
// truly pathological run; it exists to make "the buffer can never grow without
// limit" a structural guarantee rather than an assumption.
const AGENT_RUN_BUFFER_CAPACITY = 1024;

class AgentRunHandle<A> implements AgentRun<A> {
  private collected = "";
  private readonly options: MakeAgentRunOptions<A>;
  private readonly stream: ReturnType<
    typeof makeReplayEventStream<AgentRuntimeEvent>
  >;

  constructor(options: MakeAgentRunOptions<A>) {
    this.options = options;
    this.stream = makeReplayEventStream<AgentRuntimeEvent>({
      capacity: AGENT_RUN_BUFFER_CAPACITY,
      onEvent: (event) => {
        if (isAssistantTextDelta(event)) {
          this.collected += event.payload.delta;
        }
        this.options.onEvent?.(event);
      },
      source: () => this.options.source(this.options.prompt),
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    return this.stream[Symbol.asyncIterator]();
  }

  async output(): Promise<A> {
    if (Option.isNone(this.options.output)) {
      throw new Error(
        "invoke() was called without an `output` schema, so there is no structured result to decode."
      );
    }
    const schema = this.options.output.value;

    const firstText = await this.text();
    const firstAttempt = decodeStructuredOutput(schema, firstText);
    if (firstAttempt.ok) {
      return firstAttempt.value;
    }

    let lastError = firstAttempt.error;
    for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt += 1) {
      const repaired = makeAgentRun({
        // Forward the caller's tap so a repair attempt's events — notably the started session id — stay observable
        // to the streaming dispatch route (e.g. streamScheduleFire), rather than being dropped on retry.
        onEvent: this.options.onEvent,
        output: this.options.output,
        prompt: composeRepairPrompt(this.options.prompt, lastError),
        source: this.options.source,
      });
      const repairedAttempt = decodeStructuredOutput(
        schema,
        await repaired.text()
      );
      if (repairedAttempt.ok) {
        return repairedAttempt.value;
      }
      lastError = repairedAttempt.error;
    }

    throw new Error(
      `The run's response did not match the requested output schema: ${lastError}`
    );
  }

  async text(): Promise<string> {
    // Iterating re-throws a source failure, matching the prior behavior.
    for await (const _event of this.stream) {
      // Drain so the run completes and the text tap has seen every event.
    }
    return this.collected;
  }
}

export { extractJsonValue, makeAgentRun };
export type { AgentRunSource, MakeAgentRunOptions };
