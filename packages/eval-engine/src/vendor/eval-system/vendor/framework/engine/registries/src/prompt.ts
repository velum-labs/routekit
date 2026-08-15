import type { Effect as EffectType } from "effect";

import { Context, Effect, Schema } from "effect";

import type {
  PromptContext,
  PromptFragment,
  PromptFragmentObject,
  PromptProvider,
  PromptProviderShape,
  PromptRegistryEntry,
} from "../../../contracts/internal/src/author-schemas/prompt.ts";

import { decodePromptProviderResult } from "../../../contracts/internal/src/author-schemas/prompt.ts";
import { namedErrorMessage } from "../../../contracts/internal/src/errors.ts";

interface RenderablePromptFragment {
  readonly name: string;
  readonly order: number;
  readonly section?: string | undefined;
  readonly sequence: number;
  readonly text: string;
}

const EMPTY_COUNT = 0;

class PromptRegistryError extends Schema.TaggedErrorClass<PromptRegistryError>()(
  "PromptRegistryError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
    name: Schema.String,
  }
) {
  override readonly message = namedErrorMessage(
    "Prompt registry",
    this.name,
    this.detail
  );
}

interface PromptRegistryShape {
  readonly assemble: (
    ctx: PromptContext
  ) => EffectType.Effect<string | undefined, PromptRegistryError>;
  readonly entries: readonly PromptRegistryEntry[];
}

class PromptRegistry extends Context.Service<
  PromptRegistry,
  PromptRegistryShape
>()("routekit-eval/runtime/PromptRegistry") {}

const adaptPromptProvider = (provider: PromptProviderShape): PromptProvider =>
  provider;

const toPromptFragmentObject = (
  fragment: PromptFragment
): PromptFragmentObject =>
  typeof fragment === "string" ? { text: fragment } : fragment;

const normalizePromptFragments = (
  fragments: readonly PromptFragment[],
  entry: PromptRegistryEntry
): readonly RenderablePromptFragment[] =>
  fragments.map((fragment) => {
    const object = toPromptFragmentObject(fragment);
    return {
      name: object.name ?? entry.name,
      order: object.order ?? entry.order,
      ...((object.section ?? entry.section)
        ? { section: object.section ?? entry.section }
        : {}),
      sequence: 0,
      text: object.text,
    };
  });

const resolvePromptEntry = (
  entry: PromptRegistryEntry,
  ctx: PromptContext
): Effect.Effect<readonly RenderablePromptFragment[], PromptRegistryError> => {
  if (entry.type === "static") {
    return Effect.succeed([
      {
        name: entry.name,
        order: entry.order,
        ...(entry.section ? { section: entry.section } : {}),
        sequence: 0,
        text: entry.text,
      },
    ]);
  }

  return Effect.tryPromise({
    catch: (cause) =>
      new PromptRegistryError({
        cause,
        detail: "Dynamic prompt provider failed",
        name: entry.name,
      }),
    try: () => Promise.resolve(entry.provider(ctx)),
  }).pipe(
    Effect.flatMap((result) =>
      decodePromptProviderResult(result).pipe(
        Effect.mapError(
          (cause) =>
            new PromptRegistryError({
              cause,
              detail: "Dynamic prompt provider returned invalid fragments",
              name: entry.name,
            })
        )
      )
    ),
    Effect.map((fragments) => normalizePromptFragments(fragments, entry))
  );
};

const assemblePrompt = Effect.fn("Prompt.assemblePrompt")(function* (
  entries: readonly PromptRegistryEntry[],
  ctx: PromptContext
) {
  const fragments: RenderablePromptFragment[] = [];
  let sequence = 0;

  for (const entry of entries) {
    const resolved = yield* resolvePromptEntry(entry, ctx);
    for (const fragment of resolved) {
      fragments.push({
        ...fragment,
        sequence,
      });
      sequence += 1;
    }
  }

  if (fragments.length === EMPTY_COUNT) {
    return;
  }

  return fragments
    .toSorted(
      (left, right) =>
        left.order - right.order || left.sequence - right.sequence
    )
    .map((fragment) =>
      fragment.section
        ? `## ${fragment.section}\n\n${fragment.text}`
        : fragment.text
    )
    .join("\n\n");
});

export const makePromptRegistry = (
  entries: readonly PromptRegistryEntry[]
): PromptRegistryShape =>
  PromptRegistry.of({
    assemble: (ctx) => assemblePrompt(entries, ctx),
    entries,
  });

export { PromptRegistryError, PromptRegistry, adaptPromptProvider };
export type { PromptRegistryShape };
