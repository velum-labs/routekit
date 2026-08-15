import { Effect, Schema } from "effect";

/**
 * The discriminant-only view of a native record that the two-stage decode
 * reads. Each adapter keeps its own envelope schema (the surrounding native
 * schemas are provider-specific), and only has to make its decoded envelope
 * satisfy this shape.
 */
export interface NativeEnvelope {
  readonly diagnosticHarness?: string;
  readonly type: string;
}

export interface NativeLineCodec<Line, Command, Err> {
  /** Decodes one JSONL record into a modeled line or a recovered unknown event. */
  readonly decodeLine: (line: string) => Effect.Effect<Line, Err>;
  /** Encodes one outbound command into a newline-terminated JSONL record. */
  readonly encodeCommand: (command: Command) => Effect.Effect<string, Err>;
}

/**
 * Both ACP provider adapters frame their native process as JSONL and decode it
 * with the same two-stage boundary: a known discriminant whose payload is
 * malformed MUST fail, while an unrecognized discriminant is recovered as an
 * unknown-event value so one odd record becomes a diagnostic instead of tearing
 * the connection down. Only the schemas, the error class, and the detail strings
 * differ, so the staging itself is bound once here.
 *
 * The protocol error stays an adapter-owned `Data.TaggedError`: its tag is what
 * downstream `catchTag` handlers match on, so it cannot be shared without
 * changing behaviour.
 */
export const makeNativeLineCodec = <
  Inbound,
  UnknownEvent,
  Command,
  Err,
>(input: {
  readonly commandSchema: Schema.ConstraintCodec<Command, unknown>;
  readonly envelopeSchema: Schema.ConstraintCodec<NativeEnvelope, unknown>;
  readonly inboundSchema: Schema.ConstraintCodec<Inbound, unknown>;
  readonly knownInboundTypes: ReadonlySet<string>;
  readonly malformedCommandDetail: string;
  readonly malformedLineDetail: string;
  readonly onUnknownEvent: (envelope: NativeEnvelope) => UnknownEvent;
  readonly protocolFailure: (detail: string) => Err;
}): NativeLineCodec<Inbound | UnknownEvent, Command, Err> => {
  const {
    commandSchema,
    envelopeSchema,
    inboundSchema,
    knownInboundTypes,
    malformedCommandDetail,
    malformedLineDetail,
    onUnknownEvent,
    protocolFailure,
  } = input;
  const malformedLine = (): Err => protocolFailure(malformedLineDetail);

  const decodeJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown)
  );
  const decodeEnvelope = Schema.decodeUnknownEffect(envelopeSchema, {
    onExcessProperty: "preserve",
  });
  const decodeInbound = Schema.decodeUnknownEffect(inboundSchema, {
    onExcessProperty: "preserve",
  });
  const encode = Schema.encodeEffect(commandSchema);

  const classifyUndecoded = (
    value: unknown
  ): Effect.Effect<UnknownEvent, Err> =>
    decodeEnvelope(value).pipe(
      Effect.mapError(malformedLine),
      Effect.flatMap((envelope) =>
        knownInboundTypes.has(envelope.type)
          ? Effect.fail(malformedLine())
          : Effect.succeed(onUnknownEvent(envelope))
      )
    );

  return {
    decodeLine: (line: string) =>
      decodeJson(line).pipe(
        Effect.mapError(malformedLine),
        Effect.flatMap((value) =>
          decodeInbound(value).pipe(
            Effect.catch(() => classifyUndecoded(value))
          )
        )
      ),
    encodeCommand: (command: Command) =>
      encode(command).pipe(
        Effect.map((encoded) => `${JSON.stringify(encoded)}\n`),
        Effect.mapError(() => protocolFailure(malformedCommandDetail))
      ),
  };
};
