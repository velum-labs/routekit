import { layer as nodeServicesLayer } from "@effect/platform-node/NodeServices";
import { Context, Data, Effect, FileSystem, Layer, Path } from "effect";

export type EvalAuthoringStatus =
  | "prepared"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "stopped";
export interface EvalAuthoringQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options?: readonly string[];
}
export interface EvalAuthoringState {
  readonly version: 1;
  readonly sessionId: string;
  readonly repository: string;
  readonly request: string;
  readonly status: EvalAuthoringStatus;
  readonly turn: number;
  readonly question?: EvalAuthoringQuestion;
  readonly answers: readonly string[];
  readonly updatedAt: string;
}
export type EvalAuthoringEvent =
  | { readonly _tag: "EvalAuthoringPrepared"; readonly state: EvalAuthoringState }
  | {
      readonly _tag: "EvalAuthoringQuestion";
      readonly state: EvalAuthoringState;
      readonly question: EvalAuthoringQuestion;
    }
  | { readonly _tag: "EvalAuthoringCompleted"; readonly state: EvalAuthoringState }
  | { readonly _tag: "EvalAuthoringStopped"; readonly state: EvalAuthoringState };
export class EvalAuthoringError extends Data.TaggedError("EvalAuthoringError")<{
  readonly sessionId: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  override get message(): string {
    return `RouteKit Eval authoring ${this.sessionId}: ${this.detail}`;
  }
}
export interface EvalAuthoringService {
  readonly prepare: (input: {
    readonly sessionId: string;
    readonly repository: string;
    readonly request: string;
    readonly stateRoot: string;
  }) => Effect.Effect<EvalAuthoringEvent, EvalAuthoringError>;
  readonly status: (
    stateRoot: string,
    sessionId: string
  ) => Effect.Effect<EvalAuthoringState | undefined, EvalAuthoringError>;
  readonly ask: (
    stateRoot: string,
    sessionId: string,
    question: EvalAuthoringQuestion
  ) => Effect.Effect<EvalAuthoringEvent, EvalAuthoringError>;
  readonly answer: (
    stateRoot: string,
    sessionId: string,
    answer: string
  ) => Effect.Effect<EvalAuthoringEvent, EvalAuthoringError>;
  readonly complete: (
    stateRoot: string,
    sessionId: string
  ) => Effect.Effect<EvalAuthoringEvent, EvalAuthoringError>;
  readonly stop: (
    stateRoot: string,
    sessionId: string
  ) => Effect.Effect<EvalAuthoringEvent, EvalAuthoringError>;
}
export class EvalAuthoring extends Context.Service<EvalAuthoring, EvalAuthoringService>()(
  "@velum-labs/routekit-eval-engine/EvalAuthoring"
) {}

const provideNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(nodeServicesLayer));
const fileFor = (
  path: { readonly join: (...parts: readonly string[]) => string },
  root: string,
  id: string
): string => path.join(root, id, "state.json");
const writeState = (root: string, state: EvalAuthoringState) =>
  provideNode(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = fileFor(path, root, state.sessionId);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return state;
    })
  );
const readState = (root: string, id: string) =>
  provideNode(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = fileFor(path, root, id);
      if (!(yield* fs.exists(file))) return undefined;
      return JSON.parse(yield* fs.readFileString(file)) as EvalAuthoringState;
    })
  );
const timestamp = (): string => new Date().toISOString();
const failure = (sessionId: string, detail: string, cause?: unknown): EvalAuthoringError =>
  new EvalAuthoringError({ sessionId, detail, ...(cause === undefined ? {} : { cause }) });
const loadRequired = (root: string, id: string) =>
  readState(root, id).pipe(
    Effect.mapError((cause) => failure(id, "could not read state", cause)),
    Effect.flatMap((state) =>
      state === undefined ? Effect.fail(failure(id, "session not found")) : Effect.succeed(state)
    )
  );
const persist = (root: string, state: EvalAuthoringState, detail: string) =>
  writeState(root, state).pipe(Effect.mapError((cause) => failure(state.sessionId, detail, cause)));

export const EvalAuthoringLive = Layer.succeed(EvalAuthoring)(
  EvalAuthoring.of({
    prepare: (input) =>
      persist(
        input.stateRoot,
        {
          version: 1,
          sessionId: input.sessionId,
          repository: input.repository,
          request: input.request,
          status: "prepared",
          turn: 0,
          answers: [],
          updatedAt: timestamp()
        },
        "could not prepare state"
      ).pipe(Effect.map((state) => ({ _tag: "EvalAuthoringPrepared" as const, state }))),
    status: (root, id) =>
      readState(root, id).pipe(
        Effect.mapError((cause) => failure(id, "could not read state", cause))
      ),
    ask: (root, id, question) =>
      loadRequired(root, id).pipe(
        Effect.flatMap((state) =>
          state.status === "waiting"
            ? Effect.fail(failure(id, "one question is already waiting for an answer"))
            : persist(
                root,
                { ...state, status: "waiting", question, updatedAt: timestamp() },
                "could not persist question"
              )
        ),
        Effect.map((state) => ({ _tag: "EvalAuthoringQuestion" as const, state, question }))
      ),
    answer: (root, id, answer) =>
      loadRequired(root, id).pipe(
        Effect.flatMap((state) =>
          state.status !== "waiting" || state.question === undefined
            ? Effect.fail(failure(id, "no question is waiting"))
            : persist(
                root,
                {
                  ...state,
                  status: "running",
                  turn: state.turn + 1,
                  question: undefined,
                  answers: [...state.answers, answer],
                  updatedAt: timestamp()
                },
                "could not persist answer"
              )
        ),
        Effect.map((state) => ({ _tag: "EvalAuthoringPrepared" as const, state }))
      ),
    complete: (root, id) =>
      loadRequired(root, id).pipe(
        Effect.flatMap((state) =>
          persist(
            root,
            { ...state, status: "completed", question: undefined, updatedAt: timestamp() },
            "could not complete session"
          )
        ),
        Effect.map((state) => ({ _tag: "EvalAuthoringCompleted" as const, state }))
      ),
    stop: (root, id) =>
      loadRequired(root, id).pipe(
        Effect.flatMap((state) =>
          persist(
            root,
            { ...state, status: "stopped", question: undefined, updatedAt: timestamp() },
            "could not stop session"
          )
        ),
        Effect.map((state) => ({ _tag: "EvalAuthoringStopped" as const, state }))
      )
  })
);
