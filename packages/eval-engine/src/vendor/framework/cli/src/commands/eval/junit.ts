// Per-test outcomes for RouteKit Eval. The results channel reports one row per
// completed *agent run*, which says a model answered but never whether the eval
// accepted the answer. `node --test` is the only thing that knows that, and it
// will report it structurally: `--test-reporter=junit
// --test-reporter-destination=<path>` writes a JUnit XML file the command reads
// back after the child exits.
//
// Structured output rather than scraping the console: the console format is a
// human surface that changes between Node releases, while the JUnit shape is the
// contract the test runner maintains for CI consumers.
import {
  Array as Arr,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
} from "effect";

/**
 * The parse rejected. Typed so the rejection stays in the error channel instead
 * of becoming a defect that kills the command after the tests already ran.
 */
class EvalJunitParseError extends Data.TaggedError("EvalJunitParseError")<{
  readonly cause: unknown;
}> {}

const JUNIT_DIR_PREFIX = "routekit-eval-junit-";
const JUNIT_FILE_NAME = "tests.xml";

/**
 * One `test()` from the run.
 *
 * `status` is three-valued rather than a boolean because a skipped test is not a
 * pass and not a failure, and collapsing it either way misleads: a bakeoff that
 * reports a `.skip`ped model as passing is exactly the lie this field exists to
 * prevent, and reporting it as failing blames a model that never ran.
 *
 * It is also a narrower question than whether the agent worked at all: a model
 * answering "Lyon" is `fail` having run perfectly, and a model that times out is
 * `fail` too. Those two are told apart by pairing this with `data.results`.
 *
 * `durationMs` is Node's own per-test measurement, so it covers the whole test
 * body rather than just the agent call the SDK times.
 */
const EvalTestStatus = Schema.Literals(["pass", "fail", "skipped"]);

const EvalTestRowSchema = Schema.Struct({
  durationMs: Schema.optional(Schema.Finite),
  file: Schema.optional(Schema.String),
  name: Schema.String,
  status: EvalTestStatus,
});

type EvalTestRow = typeof EvalTestRowSchema.Type;

const SECONDS_TO_MS = 1000;

// XML entities, longest-first so `&amp;` is applied last. Decoding `&amp;` first
// would turn `&amp;lt;` into `<` instead of the literal `&lt;` the producer
// escaped, which is the classic double-unescape bug.
const XML_ENTITIES: readonly (readonly [string, string])[] = [
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"],
];

const unescapeXml = (value: string): string => {
  let decoded = value;
  for (const [entity, character] of XML_ENTITIES) {
    decoded = decoded.replaceAll(entity, character);
  }
  return decoded;
};

const parseSeconds = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * SECONDS_TO_MS : undefined;
};

const ATTRIBUTES = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;

const parseAttributes = (raw: string): Readonly<Record<string, string>> => {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTES)) {
    const name = match[1];
    if (name === undefined) {
      continue;
    }
    attributes[name] = unescapeXml(match[2] ?? match[3] ?? "");
  }
  return attributes;
};

// Node's junit reporter, measured on v24.5.0:
//   <testcase name="runs" time="0.000619" classname="test"/>
//   <testcase name="skipped" ...><skipped type="skipped" message="true"/></testcase>
//   <testcase name="todo one" ...><skipped type="todo" message="true"/></testcase>
//   <testcase name="fails" ... failure="..."><failure type="testCodeFailure" ...>
// Nested `describe` wraps cases in `<testsuite>`; there is no `file` attribute.
const TESTCASE =
  /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/giu;

const parseNodeJunit = (xml: string): readonly EvalTestRow[] => {
  const rows: EvalTestRow[] = [];
  for (const match of xml.matchAll(TESTCASE)) {
    const attributes = parseAttributes(match[1] ?? "");
    const inner = match[2] ?? "";
    const durationMs = parseSeconds(attributes.time);
    const file = attributes.file;
    const failed =
      attributes.failure !== undefined ||
      /<(?:failure|error)\b/iu.test(inner);
    const skipped = /<skipped\b/iu.test(inner);
    rows.push({
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(file === undefined || file === "" ? {} : { file }),
      name: attributes.name ?? "",
      status: failed ? "fail" : skipped ? "skipped" : "pass",
    });
  }
  return rows;
};

/**
 * Create the scoped directory holding the JUnit file and return the path the
 * child should write. The directory is removed when the caller's scope closes,
 * so no eval run leaves a temp dir behind.
 */
export const makeEvalJunitPath = Effect.fn("EvalJunit.makePath")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({
    prefix: JUNIT_DIR_PREFIX,
  });
  return path.join(directory, JUNIT_FILE_NAME);
});

/**
 * Extract the `<testcase>` elements and their outcome from Node's junit XML.
 * A self-closing `<testcase/>` with no child passed. `<failure>` / `<error>`
 * (and a `failure="..."` attribute) are fails. `<skipped type="skipped">` and
 * `<skipped type="todo">` are skipped.
 *
 * Parsed from the captured Node reporter shape rather than a browser HTML
 * rewriter, so a truncated document yields the cases it managed to read.
 *
 * `try` rather than a defect: a reject stays in the error channel so a bad file
 * cannot take the command down AFTER the child already spent its model calls,
 * which is the opposite of what {@link readEvalTests} promises.
 */
const parseJunit = (
  xml: string
): Effect.Effect<readonly EvalTestRow[], EvalJunitParseError> =>
  Effect.try({
    catch: (cause) => new EvalJunitParseError({ cause }),
    try: () => parseNodeJunit(xml),
  });

/**
 * Read back the per-test outcomes the child reported.
 *
 * Absent file → `[]`: a `--list` run never spawns the child, and a child that
 * died before writing leaves nothing, both of which are normal rather than
 * errors. A row that does not decode is skipped for the same reason a corrupt
 * results line is: the cases that did report are the point of the file.
 */
export const readEvalTests = Effect.fn("EvalJunit.read")(function* (
  junitPath: string
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(junitPath).pipe(Effect.option);
  if (Option.isNone(contents)) {
    return [];
  }
  const decode = Schema.decodeUnknownOption(EvalTestRowSchema);
  // A parse that somehow rejects degrades to "no cases reported" rather than
  // escaping into the command's error channel, so a bad file can never fail a run
  // whose tests already finished. Absorbed here rather than in `parseJunit` so
  // that function keeps an honest error type.
  const parsed = yield* parseJunit(contents.value).pipe(
    Effect.orElseSucceed((): readonly EvalTestRow[] => [])
  );
  return Arr.getSomes(parsed.map((row) => decode(row)));
});

export { EvalTestRowSchema, EvalTestStatus };
export type { EvalTestRow };
