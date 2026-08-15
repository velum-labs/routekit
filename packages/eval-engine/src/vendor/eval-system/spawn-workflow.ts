import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { readTextAsset } from "./runtime/text-asset.ts";
import { AUTHOR_HARNESSES, SPAWN_EXIT, SPAWN_PROTOCOL_VERSION } from "./host-contract.ts";
import {
  EVAL_INFERENCE_ORIGIN_ENV,
  evalInferenceOrigin,
  hostCredentialPresent,
  ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
} from "./host-env.ts";
import {
  COPY_IGNORE_NAMES,
  MAX_PRIVATE_COPY_BYTES,
  MAX_PRIVATE_COPY_FILES,
  cheaperRerunLine,
  classifySpawnReply,
  isInsideRoot,
  parseQuestionOptions,
  renderCostTable,
  replaceBakeoff,
  tableHeaderRow,
} from "./spawn-protocol.ts";

const createEvalSkill = readTextAsset(import.meta.url, "../../../assets/skills/create-eval.SKILL.md");
const spawnSkill = readTextAsset(import.meta.url, "../../../assets/skills/spawn-routekit-eval/SKILL.md");

const PROTOCOL_VERSION = SPAWN_PROTOCOL_VERSION;
const DEFAULT_RUN_MODEL = "openai/gpt-5.6-terra";
const DEFAULT_JUDGE_MODEL = "openai/gpt-5.6-terra";
const DEFAULT_HARNESS = "pi";
const CREATE_EVAL_SKILL_SHA256 = createHash("sha256").update(createEvalSkill).digest("hex");
const SPAWN_SKILL_SHA256 = createHash("sha256").update(spawnSkill).digest("hex");
const QUESTION_TAGS = [
  "surface",
  "workspace-files",
  "workspace-data",
  "criteria-priority",
  "evaluation-constraint",
  "candidates",
  "next-step",
] as const;

type QuestionTag = (typeof QUESTION_TAGS)[number];
type RunStatus = "prepared" | "running" | "waiting" | "completed" | "failed" | "stopped";
type ExistingChoice = "resume" | "archive" | "stop";

interface SpawnQuestion {
  readonly context: string;
  readonly tag: QuestionTag | "untagged";
  readonly text: string;
  readonly violation?: string;
}

interface AttemptRecord {
  readonly answerFile: string;
  readonly durationMs: number;
  readonly endedAt: string;
  readonly errorFile: string;
  readonly exitCode: number;
  readonly number: number;
  readonly startedAt: string;
  readonly summary?: AttemptSummary;
}

interface AttemptSummary {
  readonly contextTokens?: number;
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly inputTokens?: number;
  readonly model?: string;
  readonly outputTokens?: number;
  readonly requestedModel?: string;
}

interface SpawnState {
  readonly activeQuestion?: SpawnQuestion;
  readonly activeChildPid?: number;
  readonly attempts: readonly AttemptRecord[];
  readonly authorWorkspace: string;
  readonly createdAt: string;
  readonly createEvalSkillSha256: string;
  readonly harness: string;
  readonly judgeModel: string;
  readonly protocolVersion: 2;
  readonly repoRoot: string;
  readonly request: string;
  readonly runDirectory: string;
  readonly runModel: string;
  readonly scratchWorkspace?: string;
  readonly spawnSkillSha256: string;
  readonly status: RunStatus;
  readonly updatedAt: string;
}

interface StateRead {
  readonly state?: SpawnState;
  readonly error?: string;
}

interface ParsedArgs {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | true>;
}

const parseArgs = (args: readonly string[]): ParsedArgs => {
  const command = args[0] ?? "help";
  const flags = new Map<string, string | true>();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || !arg.startsWith("--")) continue;
    const inline = arg.indexOf("=");
    if (inline > 0) {
      flags.set(arg.slice(0, inline), arg.slice(inline + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(arg, next);
      index += 1;
    } else {
      flags.set(arg, true);
    }
  }
  return { command, flags };
};

const stringFlag = (flags: ParsedArgs["flags"], name: string): string | undefined => {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
};

const readAuthorHarness = (flags: ParsedArgs["flags"]): string => {
  const value = stringFlag(flags, "--harness") ?? DEFAULT_HARNESS;
  if (!(AUTHOR_HARNESSES as readonly string[]).includes(value)) {
    fail(`unknown author harness ${value}; expected ${AUTHOR_HARNESSES.join(", ")}`);
  }
  return value;
};

type SpawnExitCode = (typeof SPAWN_EXIT)[keyof typeof SPAWN_EXIT];

const fail = (message: string, exitCode: SpawnExitCode = SPAWN_EXIT.usage): never => {
  const error = new Error(message) as Error & { exitCode?: number };
  error.exitCode = exitCode;
  throw error;
};

const requireValue = <T>(
  value: T | undefined,
  message: string,
  exitCode: SpawnExitCode = SPAWN_EXIT.usage,
): T => {
  if (value === undefined) {
    throw Object.assign(new Error(message), { exitCode });
  }
  return value;
};

const writeJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const collectStreamText = async (
  stream: NodeJS.ReadableStream | null,
): Promise<string> => {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const closeCode = (code: unknown): number => (typeof code === "number" ? code : 1);

const repositoryRoot = async (requested?: string): Promise<string> => {
  const cwd = await realpath(requested ?? process.cwd());
  try {
    const child = spawn("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stdoutPromise = collectStreamText(child.stdout);
    await once(child, "spawn");
    const [outputRaw, closeArgs] = await Promise.all([stdoutPromise, once(child, "close")]);
    const output = outputRaw.trim();
    return closeCode(closeArgs[0]) === 0 && output !== "" ? await realpath(output) : cwd;
  } catch {
    return cwd;
  }
};

const runDirectoryFor = (repoRoot: string): string => {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  return `/tmp/spawn-routekit-eval-${hash}`;
};

const statePath = (runDirectory: string): string => path.join(runDirectory, "state.json");
const taskPath = (runDirectory: string): string => path.join(runDirectory, "task.txt");
const stepsPath = (runDirectory: string): string => path.join(runDirectory, "steps.txt");
const lockPath = (runDirectory: string): string => path.join(runDirectory, "run.lock");
const authorWorkspacePath = (runDirectory: string): string => path.join(runDirectory, "repository");
const binaryDirectoryPath = (runDirectory: string): string => path.join(runDirectory, "bin");
const authorWorkspaceReadyPath = (runDirectory: string): string =>
  path.join(runDirectory, "repository.ready");
const sourceSnapshotPath = (runDirectory: string): string =>
  path.join(runDirectory, "source-snapshot.json");
const sourceMutationPath = (runDirectory: string): string =>
  path.join(runDirectory, "source-mutation.json");
const scratchWorkspaceRecordPath = (runDirectory: string): string =>
  path.join(runDirectory, "routekit-eval", "scratch-workspace.txt");
const evalRunRecordsPath = (runDirectory: string): string =>
  path.join(runDirectory, "routekit-eval", "eval-runs.jsonl");

const withoutActiveQuestion = (state: SpawnState): Omit<SpawnState, "activeQuestion"> => {
  const { activeQuestion: _activeQuestion, ...rest } = state;
  return rest;
};

const withoutActiveChild = (state: SpawnState): Omit<SpawnState, "activeChildPid"> => {
  const { activeChildPid: _activeChildPid, ...rest } = state;
  return rest;
};

const atomicWrite = async (target: string, contents: string): Promise<void> => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
};

interface TreeEntry {
  readonly kind: "directory" | "file" | "symlink" | "other";
  readonly contentSha256?: string;
  readonly linkTarget?: string;
  readonly mode: number;
  readonly path: string;
  readonly size: number;
}

const hashFileContents = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const walkTree = async (root: string, relative = ""): Promise<readonly TreeEntry[]> => {
  const directory = path.join(root, relative);
  const names = await readdir(directory);
  const entries: TreeEntry[] = [];
  for (const name of names.sort()) {
    if (COPY_IGNORE_NAMES.has(name)) continue;
    const childRelative = path.join(relative, name);
    const childPath = path.join(root, childRelative);
    const info = await lstat(childPath);
    const kind = info.isDirectory()
      ? "directory"
      : info.isFile()
        ? "file"
        : info.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push({
      kind,
      mode: info.mode,
      path: childRelative,
      size: info.size,
      ...(kind === "file" ? { contentSha256: await hashFileContents(childPath) } : {}),
      ...(kind === "symlink" ? { linkTarget: await readlink(childPath) } : {}),
    });
    if (kind === "directory") {
      entries.push(...(await walkTree(root, childRelative)));
    }
  }
  return entries;
};

const treeDigest = (entries: readonly TreeEntry[]): string =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex");

const captureSourceSnapshot = async (
  repoRoot: string,
): Promise<{
  readonly digest: string;
  readonly entries: readonly TreeEntry[];
}> => {
  const entries = await walkTree(repoRoot);
  return { digest: treeDigest(entries), entries };
};

const sourceMutation = (
  before: readonly TreeEntry[],
  after: readonly TreeEntry[],
): {
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
} => {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const added = [...afterByPath.keys()].filter((entryPath) => !beforeByPath.has(entryPath));
  const removed = [...beforeByPath.keys()].filter((entryPath) => !afterByPath.has(entryPath));
  const changed = [...beforeByPath.keys()].filter((entryPath) => {
    const beforeEntry = beforeByPath.get(entryPath);
    const afterEntry = afterByPath.get(entryPath);
    return (
      beforeEntry !== undefined &&
      afterEntry !== undefined &&
      JSON.stringify(beforeEntry) !== JSON.stringify(afterEntry)
    );
  });
  return { added, changed, removed };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readState = async (runDirectory: string): Promise<StateRead> => {
  let raw: string;
  try {
    raw = await readFile(statePath(runDirectory), "utf8");
  } catch (error) {
    return {
      error:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "state.json is absent"
          : `state.json could not be read: ${String(error)}`,
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error) {
    return { error: `state.json is not valid JSON: ${String(error)}` };
  }
  if (!isRecord(decoded)) {
    return { error: "state.json is not an object" };
  }
  if (decoded.protocolVersion !== PROTOCOL_VERSION) {
    return {
      error: `state protocol ${String(decoded.protocolVersion)} is incompatible with ${PROTOCOL_VERSION}`,
    };
  }
  const requiredStrings = [
    "authorWorkspace",
    "createdAt",
    "createEvalSkillSha256",
    "harness",
    "judgeModel",
    "repoRoot",
    "runDirectory",
    "runModel",
    "spawnSkillSha256",
    "status",
    "updatedAt",
  ] as const;
  for (const key of requiredStrings) {
    if (typeof decoded[key] !== "string" || decoded[key].trim() === "") {
      return { error: `state.json has an invalid ${key}` };
    }
  }
  if (typeof decoded.request !== "string") {
    return { error: "state.json has an invalid request" };
  }
  if (!Array.isArray(decoded.attempts)) {
    return { error: "state.json has an invalid attempts list" };
  }
  if (decoded.createEvalSkillSha256 !== CREATE_EVAL_SKILL_SHA256) {
    return {
      error: "the prepared run uses a different create-eval skill; archive it before continuing",
    };
  }
  if (decoded.spawnSkillSha256 !== SPAWN_SKILL_SHA256) {
    return {
      error: "the prepared run uses a different spawn protocol skill; archive it before continuing",
    };
  }
  return { state: decoded as unknown as SpawnState };
};

const requireState = async (runDirectory: string, missingMessage: string): Promise<SpawnState> => {
  const result = await readState(runDirectory);
  if (result.state !== undefined) {
    return result.state;
  }
  throw Object.assign(new Error(`${missingMessage}: ${result.error ?? "unknown state error"}`), {
    exitCode: 2,
  });
};

const persistState = async (state: SpawnState): Promise<void> => {
  await atomicWrite(statePath(state.runDirectory), `${JSON.stringify(state, null, 2)}\n`);
};

const promptText = (input: {
  readonly authorWorkspace: string;
  readonly judgeModel: string;
  readonly request: string;
  readonly runDirectory: string;
}): string => `Use the create-eval skill. Follow its five phases in this order: workspace
context, criteria and narrowing, model comparison, routing, close. There are
seven possible question tags in this order: \`[surface]\`, \`[workspace-files]\`,
\`[workspace-data]\`, \`[criteria-priority]\`, \`[evaluation-constraint]\`,
\`[candidates]\`, and \`[next-step]\`. The first two are mutually exclusive
conditional questions, so each run asks five or six questions.
Ask exactly one question per turn and end the turn after asking it. Give each
question three concrete options plus a free-text \`Other\` option. Never combine
questions in one turn.

Judge with ${input.judgeModel} rather than the SDK's default judge model: pass it
to setupJudge as its own agent.

User request: ${input.request}
Your working copy is ${input.authorWorkspace}. Read and work only in this copy.
It is a private copy made outside the user's repository so normal coding tools
can operate without putting generated files into the source tree. Do not create
or modify anything in the user's repository.

The RouteKitEval directory is ${input.runDirectory}/routekit-eval. Create it if it is absent.
Keep the step tracker and every file you write outside the scratch workspace
under that directory. Record the scratch workspace path you report in the
tracker directory. Do not derive another tracker path, and do not adopt or
resume tracker state outside it. The scratch workspace path you report is the
only other location this run may use for its eval and supporting files. Any
other tracker or state files outside these locations belong to a different
session. Keep the eval and supporting files in that scratch workspace outside
the user's repository. Run the eval with routekit-eval eval. Do not create or modify
anything in the user's repository.
`;

const renderSteps = (state: SpawnState): string => {
  const completed = state.status === "completed";
  return (
    [
      `request: ${state.request.replaceAll(/\s+/gu, " ").trim()}`,
      `author harness: ${state.harness}`,
      `author model: ${state.runModel}`,
      `judge model: ${state.judgeModel}`,
      `run directory: ${state.runDirectory}`,
      `status: ${state.status}`,
      `attempts: ${state.attempts.length}`,
      `workflow: ${completed ? "done" : state.status === "waiting" ? "waiting for user answer" : "in progress"}`,
    ].join("\n") + "\n"
  );
};

const archiveExisting = async (runDirectory: string): Promise<string> => {
  const previous = path.join(runDirectory, "previous");
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  let destination = path.join(previous, stamp);
  for (let suffix = 1; await pathExists(destination); suffix += 1) {
    destination = path.join(previous, `${stamp}-${suffix}`);
  }
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(runDirectory)) {
    if (entry === "previous") continue;
    await rename(path.join(runDirectory, entry), path.join(destination, entry));
  }
  return destination;
};

const requestText = async (parsed: ParsedArgs): Promise<string> => {
  const direct = stringFlag(parsed.flags, "--request");
  const file = stringFlag(parsed.flags, "--request-file");
  if (direct !== undefined && file !== undefined)
    fail("use only one of --request and --request-file");
  const value = file === undefined ? direct : await readFile(path.resolve(file), "utf8");
  return value?.trim() ?? "";
};

const prepare = async (parsed: ParsedArgs): Promise<void> => {
  const repoRoot = await repositoryRoot(stringFlag(parsed.flags, "--repo"));
  const runDirectory = runDirectoryFor(repoRoot);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
  const request = await requestText(parsed);
  const existingRead = await readState(runDirectory);
  const existing = existingRead.state;
  const runFiles = (await readdir(runDirectory)).filter((entry) => entry !== "previous");
  const choice = stringFlag(parsed.flags, "--existing") as ExistingChoice | undefined;

  if ((existing !== undefined || runFiles.length > 0) && choice === undefined) {
    writeJson({
      ok: true,
      status: "action-required",
      runDirectory,
      existing:
        existing === undefined
          ? {
              files: runFiles,
              reason:
                existingRead.error ?? "run files exist but state.json is absent or unreadable",
              resumable: false,
            }
          : {
              attempts: existing.attempts.length,
              request: existing.request,
              sameRequest:
                existing.request.replaceAll(/\s+/gu, " ").trim() ===
                request.replaceAll(/\s+/gu, " ").trim(),
              status: existing.status,
              updatedAt: existing.updatedAt,
            },
      choices:
        existing !== undefined &&
        existing.status !== "completed" &&
        existing.request.replaceAll(/\s+/gu, " ").trim() === request.replaceAll(/\s+/gu, " ").trim()
          ? ["resume", "archive", "stop"]
          : ["archive", "stop"],
    });
    return;
  }
  if (choice === "stop") {
    // "Stop" means leave paid work exactly as found. It is a caller decision,
    // not a lifecycle transition owned by this process.
    writeJson({ ok: true, status: "stopped", runDirectory });
    return;
  }
  if (choice === "resume") {
    const resumed = requireValue(existing, "there is no existing run to resume");
    if (
      resumed.request.replaceAll(/\s+/gu, " ").trim() !== request.replaceAll(/\s+/gu, " ").trim()
    ) {
      fail("the existing run belongs to a different normalized request; archive it or stop");
    }
    writeJson({ ok: true, status: resumed.status, runDirectory, state: resumed });
    return;
  }
  let archived: string | undefined;
  if (existing !== undefined || runFiles.length > 0) {
    if (choice !== "archive") fail("existing run requires --existing resume|archive|stop");
    archived = await archiveExisting(runDirectory);
  }

  const now = new Date().toISOString();
  const state: SpawnState = {
    attempts: [],
    authorWorkspace: authorWorkspacePath(runDirectory),
    createdAt: now,
    createEvalSkillSha256: CREATE_EVAL_SKILL_SHA256,
    harness: readAuthorHarness(parsed.flags),
    judgeModel: stringFlag(parsed.flags, "--judge-model") ?? DEFAULT_JUDGE_MODEL,
    protocolVersion: PROTOCOL_VERSION,
    repoRoot,
    request,
    runDirectory,
    runModel: stringFlag(parsed.flags, "--model") ?? DEFAULT_RUN_MODEL,
    spawnSkillSha256: SPAWN_SKILL_SHA256,
    status: "prepared",
    updatedAt: now,
  };
  await mkdir(path.join(runDirectory, "routekit-eval"), { recursive: true, mode: 0o700 });
  const snapshot = await captureSourceSnapshot(repoRoot);
  await atomicWrite(sourceSnapshotPath(runDirectory), `${JSON.stringify(snapshot, null, 2)}\n`);
  await atomicWrite(taskPath(runDirectory), promptText(state));
  await persistState(state);
  await atomicWrite(stepsPath(runDirectory), renderSteps(state));
  writeJson({
    ok: true,
    status: "prepared",
    runDirectory,
    ...(archived === undefined ? {} : { archived }),
    state,
  });
};

const executableArgv = (): readonly string[] => {
  const override = process.env.ROUTEKIT_EVAL_SYSTEM_BINARY?.trim();
  if (override) return [override];
  return [process.execPath, process.argv[1]];
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const acquireRunLock = async (runDirectory: string) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath(runDirectory), "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      return handle;
    } catch {
      const ownerText = await readFile(lockPath(runDirectory), "utf8")
        .then((value) => value.trim())
        .catch(() => "");
      const owner = Number(ownerText);
      if (attempt === 0 && Number.isSafeInteger(owner) && owner > 0 && !processIsAlive(owner)) {
        await unlink(lockPath(runDirectory)).catch(() => undefined);
        continue;
      }
      fail(
        `another spawn run owns ${lockPath(runDirectory)}${ownerText === "" ? "" : ` (pid ${ownerText})`}`,
        SPAWN_EXIT.conflict,
      );
    }
  }
  fail(`could not acquire ${lockPath(runDirectory)}`, SPAWN_EXIT.conflict);
};

const withRunLock = async <T>(runDirectory: string, effect: () => Promise<T>): Promise<T> => {
  const handle = await acquireRunLock(runDirectory);
  try {
    return await effect();
  } finally {
    await handle?.close();
    try {
      const contents = (await readFile(lockPath(runDirectory), "utf8")).trim();
      if (contents === String(process.pid)) await unlink(lockPath(runDirectory));
    } catch {
      /* already gone */
    }
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const questionRelay = (question: SpawnQuestion) => {
  const parsed = parseQuestionOptions(question.text);
  return {
    context: replaceBakeoff(question.context),
    options: parsed.options,
    prompt: replaceBakeoff(parsed.prompt),
    question: replaceBakeoff(question.text),
    tableHeader: tableHeaderRow(question.context),
    tag: question.tag,
    ...(question.violation === undefined ? {} : { violation: question.violation }),
  };
};

const copyRepositoryTree = async (
  sourceRoot: string,
  destRoot: string,
): Promise<readonly { readonly path: string; readonly target: string }[]> => {
  const skipped: { readonly path: string; readonly target: string }[] = [];
  const walk = async (relative: string): Promise<void> => {
    const sourceDirectory = path.join(sourceRoot, relative);
    const destDirectory = path.join(destRoot, relative);
    await mkdir(destDirectory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(sourceDirectory)) {
      if (COPY_IGNORE_NAMES.has(name)) continue;
      const childRelative = relative === "" ? name : path.join(relative, name);
      const sourcePath = path.join(sourceRoot, childRelative);
      const destPath = path.join(destRoot, childRelative);
      const info = await lstat(sourcePath);
      if (info.isDirectory()) {
        await walk(childRelative);
        continue;
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(sourcePath);
        const resolved = path.resolve(path.dirname(sourcePath), target);
        if (!isInsideRoot(sourceRoot, resolved)) {
          skipped.push({ path: childRelative, target });
          continue;
        }
        const copiedTarget = path.join(destRoot, path.relative(sourceRoot, resolved));
        await symlink(path.relative(path.dirname(destPath), copiedTarget), destPath);
        continue;
      }
      if (info.isFile()) {
        await copyFile(sourcePath, destPath);
        await chmod(destPath, info.mode & 0o777);
      }
    }
  };
  await walk("");
  return skipped;
};

const ensureRouteKitEvalShim = async (runDirectory: string): Promise<string> => {
  const directory = binaryDirectoryPath(runDirectory);
  const target = path.join(directory, "routekit-eval");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(target, `#!/bin/sh\nexec ${executableArgv().map(shellQuote).join(" ")} "$@"\n`);
  await chmod(target, 0o700);
  return directory;
};

const ensureAuthorWorkspace = async (state: SpawnState): Promise<void> => {
  if (await pathExists(authorWorkspaceReadyPath(state.runDirectory))) {
    const info = await stat(state.authorWorkspace).catch(() => undefined);
    if (info?.isDirectory()) return;
    fail(
      `the author workspace ready marker exists but its directory is missing: ${state.authorWorkspace}`,
    );
  }
  const staging = `${state.authorWorkspace}.copy-${process.pid}-${crypto.randomUUID()}`;
  await rm(staging, { recursive: true, force: true });
  try {
    const skippedExternalSymlinks = await copyRepositoryTree(state.repoRoot, staging);
    await atomicWrite(
      path.join(state.runDirectory, "routekit-eval", "external-symlinks.json"),
      `${JSON.stringify({ skipped: skippedExternalSymlinks }, null, 2)}\n`,
    );
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    fail(
      `could not create the private repository copy at ${state.authorWorkspace}: ${String(error)}`,
      SPAWN_EXIT.conflict,
    );
  }
  await rm(state.authorWorkspace, { recursive: true, force: true });
  await rename(staging, state.authorWorkspace);
  await atomicWrite(authorWorkspaceReadyPath(state.runDirectory), `${new Date().toISOString()}\n`);
};

const parseSummary = (answer: string): AttemptSummary | undefined => {
  const line = answer.trimEnd().split("\n").at(-1);
  if (line === undefined || !line.startsWith("summary  ")) return undefined;
  const value = (pattern: RegExp): string | undefined => pattern.exec(line)?.[1];
  const number = (pattern: RegExp): number | undefined => {
    const raw = value(pattern);
    const parsed = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const model = value(/(?:^|\s{2})model=([^\s]+)/u);
  const requestedModel = value(/(?:^|\s{2})requested-model=([^\s]+)/u);
  const durationMs = number(/(?:^|\s{2})duration=(\d+)ms/u);
  const inputTokens = number(/(?:^|\s{2})input=(\d+) tok/u);
  const outputTokens = number(/(?:^|\s{2})output=(\d+) tok/u);
  const contextTokens = number(/(?:^|\s{2})context=(\d+) tok/u);
  const costUsd = number(/(?:^|\s{2})\$(\d+(?:\.\d+)?)/u);
  return {
    ...(model === undefined ? {} : { model }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  };
};

const assistantText = (answer: string): string => {
  const lines = answer.trimEnd().split("\n");
  if (lines.at(-1)?.startsWith("summary  ")) lines.pop();
  return lines.join("\n").trim();
};

const parseQuestion = (answer: string): SpawnQuestion | undefined => {
  const text = assistantText(answer);
  const matches = [
    ...text.matchAll(
      /\[(surface|workspace-files|workspace-data|criteria-priority|evaluation-constraint|candidates|next-step)\]/gu,
    ),
  ];
  if (matches.length > 0) {
    const first = matches[0];
    if (first === undefined || first.index === undefined) return undefined;
    const second = matches[1];
    const end = second === undefined || second.index === undefined ? text.length : second.index;
    return {
      context: text.slice(0, first.index).trim(),
      tag: first[1] as QuestionTag,
      text: text.slice(first.index, end).trim(),
      ...(matches.length > 1
        ? {
            violation: `one-question contract violated: emitted ${matches.length} tagged questions`,
          }
        : {}),
    };
  }
  if (/\?\s*$/u.test(text)) {
    const paragraphs = text.split(/\n\s*\n/u);
    const question = paragraphs.at(-1) ?? text;
    return {
      context: paragraphs.slice(0, -1).join("\n\n").trim(),
      tag: "untagged",
      text: question.trim(),
      violation: "one-question contract violated: final question had no recognized tag",
    };
  }
  return undefined;
};

interface ProviderFailure {
  readonly kind: "insufficient-credit" | "rate-limit" | "provider-timeout";
  readonly recoverable: true;
}

const classifyProviderFailure = (text: string): ProviderFailure | undefined => {
  if (
    /manage it using|insufficient credit|payment required|\bHTTP 402\b|\b402\b/iu.test(
      text,
    )
  ) {
    return { kind: "insufficient-credit", recoverable: true };
  }
  if (/rate limit|\bHTTP 429\b|\b429\b/iu.test(text)) {
    return { kind: "rate-limit", recoverable: true };
  }
  if (/timed out|etimedout|provider-timeout|deadline exceeded/iu.test(text)) {
    return { kind: "provider-timeout", recoverable: true };
  }
  return undefined;
};

const discoverScratchWorkspace = (answer: string): string | undefined => {
  const match = /\/tmp\/routekit-eval-eval-scratch-[A-Za-z0-9_-]+/u.exec(answer);
  return match?.[0];
};

const readStructuredScratchWorkspace = async (
  runDirectory: string,
): Promise<string | undefined> => {
  const recorded = await readFile(scratchWorkspaceRecordPath(runDirectory), "utf8").catch(() => "");
  const value = recorded.trim();
  return value === "" ? undefined : value;
};

interface EvalRunRecord {
  readonly endedAt: string;
  readonly exitCode: number;
  readonly files: readonly string[];
  readonly results: readonly {
    readonly durationMs?: number;
    readonly role?: string;
    readonly usage?: {
      readonly costUsd?: number;
    };
  }[];
  readonly tests: readonly unknown[];
  readonly workingDirectory: string;
}

const readEvalRunRecords = async (runDirectory: string): Promise<readonly EvalRunRecord[]> => {
  const contents = await readFile(evalRunRecordsPath(runDirectory), "utf8").catch(() => "");
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as EvalRunRecord];
      } catch {
        return [];
      }
    });
};

const evalRunTotals = (
  records: readonly EvalRunRecord[],
): {
  readonly candidateCostUsd?: number;
  readonly candidateDurationMs?: number;
  readonly judgeCostUsd?: number;
  readonly judgeDurationMs?: number;
  readonly runs: number;
} => {
  const rows = records.flatMap((record) => record.results);
  const total = (role: "candidate" | "judge", field: "cost" | "duration"): number | undefined => {
    const values = rows.flatMap((row) => {
      if (row.role !== role) return [];
      const value = field === "cost" ? row.usage?.costUsd : row.durationMs;
      return value === undefined ? [] : [value];
    });
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
  };
  const candidateCostUsd = total("candidate", "cost");
  const candidateDurationMs = total("candidate", "duration");
  const judgeCostUsd = total("judge", "cost");
  const judgeDurationMs = total("judge", "duration");
  return {
    ...(candidateCostUsd === undefined ? {} : { candidateCostUsd }),
    ...(candidateDurationMs === undefined ? {} : { candidateDurationMs }),
    ...(judgeCostUsd === undefined ? {} : { judgeCostUsd }),
    ...(judgeDurationMs === undefined ? {} : { judgeDurationMs }),
    runs: records.length,
  };
};

const totalRegularFileBytes = (entries: readonly TreeEntry[]): number =>
  entries.reduce((total, entry) => total + (entry.kind === "file" ? entry.size : 0), 0);

const availableBytes = async (target: string): Promise<number | undefined> => {
  try {
    const info = await statfs(target);
    return Number(info.bavail * info.bsize);
  } catch {
    return undefined;
  }
};

const ensureCopyCapacity = async (state: SpawnState): Promise<void> => {
  const snapshot = JSON.parse(await readFile(sourceSnapshotPath(state.runDirectory), "utf8")) as {
    readonly entries: readonly TreeEntry[];
  };
  const fileCount = snapshot.entries.filter((entry) => entry.kind === "file").length;
  if (fileCount > MAX_PRIVATE_COPY_FILES) {
    fail(
      `the repository is too large to copy privately: ${fileCount} files (limit ${MAX_PRIVATE_COPY_FILES}). Exclude generated directories or pass a smaller tree.`,
      3,
    );
  }
  const requiredBytes = totalRegularFileBytes(snapshot.entries);
  if (requiredBytes > MAX_PRIVATE_COPY_BYTES) {
    fail(
      `the repository is too large to copy privately: ${requiredBytes} bytes (limit ${MAX_PRIVATE_COPY_BYTES}).`,
      3,
    );
  }
  const freeBytes = await availableBytes(state.runDirectory);
  if (freeBytes !== undefined && freeBytes < requiredBytes * 1.1) {
    fail(
      `not enough free disk space for the private repository copy: need at least ${Math.ceil(requiredBytes * 1.1)} bytes, have ${freeBytes}`,
      SPAWN_EXIT.conflict,
    );
  }
};

const attemptTotals = (
  attempts: readonly AttemptRecord[],
): {
  readonly costUsd?: number;
  readonly durationMs?: number;
  readonly unmeasuredAttempts: number;
} => {
  const measuredCosts = attempts.flatMap((attempt) =>
    attempt.summary?.costUsd === undefined ? [] : [attempt.summary.costUsd],
  );
  const measuredDurations = attempts.flatMap((attempt) =>
    attempt.summary?.durationMs === undefined ? [] : [attempt.summary.durationMs],
  );
  return {
    ...(measuredCosts.length === 0
      ? {}
      : { costUsd: measuredCosts.reduce((sum, value) => sum + value, 0) }),
    ...(measuredDurations.length === 0
      ? {}
      : { durationMs: measuredDurations.reduce((sum, value) => sum + value, 0) }),
    unmeasuredAttempts: attempts.filter((attempt) => attempt.summary === undefined).length,
  };
};

const resolveRunDirectory = async (parsed: ParsedArgs): Promise<string> => {
  const explicit = stringFlag(parsed.flags, "--run-directory");
  return explicit ?? runDirectoryFor(await repositoryRoot(stringFlag(parsed.flags, "--repo")));
};

const run = async (parsed: ParsedArgs): Promise<void> => {
  const runDirectory = await resolveRunDirectory(parsed);
  await withRunLock(runDirectory, async () => {
    const state = await requireState(runDirectory, `no prepared run exists at ${runDirectory}`);
    if (state.status === "waiting") fail("the run is waiting for a user answer; use spawn answer");
    if (state.status === "completed")
      fail("the run is already completed; prepare with --existing archive to start fresh");
    if (
      state.status === "running" &&
      state.activeChildPid !== undefined &&
      processIsAlive(state.activeChildPid)
    ) {
      fail(
        `the recorded author process is still running (pid ${state.activeChildPid}); wait for it instead of starting a second run`,
        SPAWN_EXIT.conflict,
      );
    }
    await ensureCopyCapacity(state);
    await ensureAuthorWorkspace(state);
    const routeKitEvalShimDirectory = await ensureRouteKitEvalShim(runDirectory);
    const childEnv = {
      ...globalThis.process.env,
      ROUTEKIT_EVAL_RUN_RECORD_FILE: evalRunRecordsPath(runDirectory),
      ROUTEKIT_EVAL_SCRATCH_PATH_FILE: scratchWorkspaceRecordPath(runDirectory),
      ROUTEKIT_EVAL_TELEMETRY: globalThis.process.env.ROUTEKIT_EVAL_TELEMETRY ?? "0",
      PATH: `${routeKitEvalShimDirectory}:${globalThis.process.env.PATH ?? ""}`,
    };
    const authArgv = [...executableArgv(), "--json", "auth"];
    const [authCommand, ...authArgs] = authArgv;
    const auth = spawn(authCommand, authArgs, {
      cwd: state.authorWorkspace,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const authStdoutPromise = collectStreamText(auth.stdout);
    const authStderrPromise = collectStreamText(auth.stderr);
    await once(auth, "spawn");
    const [authStdout, authStderr, authClose] = await Promise.all([
      authStdoutPromise,
      authStderrPromise,
      once(auth, "close"),
    ]);
    const authExit = closeCode(authClose[0]);
    if (authExit !== 0) {
      writeJson({
        ok: false,
        status: "auth-required",
        runDirectory,
        detail: authStdout.trim() || authStderr.trim() || "Run `routekit-eval login`.",
      });
      process.exitCode = SPAWN_EXIT.usage;
      return;
    }
    const attemptNumber = state.attempts.length + 1;
    const answerFile = path.join(runDirectory, `answer-${attemptNumber}.txt`);
    const errorFile = path.join(runDirectory, `error-${attemptNumber}.log`);
    const startedAt = new Date().toISOString();
    const starting: SpawnState = {
      ...withoutActiveQuestion(state),
      status: "running",
      updatedAt: startedAt,
    };
    await persistState(starting);
    await atomicWrite(stepsPath(runDirectory), renderSteps(starting));
    await writeFile(answerFile, "", { mode: 0o600 });
    await writeFile(errorFile, "", { mode: 0o600 });
    const argv = [
      ...executableArgv(),
      "code",
      "--harness",
      state.harness,
      "--model",
      state.runModel,
      "--prompt-file",
      taskPath(runDirectory),
      "--output",
      "text",
    ];
    const [command, ...args] = argv;
    const sourceBeforeLive = await captureSourceSnapshot(state.repoRoot);
    await atomicWrite(
      sourceSnapshotPath(runDirectory),
      `${JSON.stringify(sourceBeforeLive, null, 2)}\n`,
    );
    const stdoutHandle = await open(answerFile, "w");
    const stderrHandle = await open(errorFile, "w");
    const child = spawn(command, args, {
      cwd: state.authorWorkspace,
      detached: true,
      env: childEnv,
      stdio: ["ignore", stdoutHandle.fd, stderrHandle.fd],
    });
    try {
      await once(child, "spawn");
    } finally {
      await stdoutHandle.close();
      await stderrHandle.close();
    }
    const childPid = requireValue(child.pid, "the author process spawned without a pid", 3);
    const running: SpawnState = {
      ...starting,
      activeChildPid: childPid,
    };
    await persistState(running);
    const forwardSignal = (signal: NodeJS.Signals): void => {
      try {
        process.kill(-childPid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The child already exited.
        }
      }
    };
    const onInterrupt = (): void => forwardSignal("SIGINT");
    const onTerminate = (): void => forwardSignal("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    let exitCode: number;
    try {
      const closeArgs = await once(child, "close");
      exitCode = closeCode(closeArgs[0]);
    } finally {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    }
    const endedAt = new Date().toISOString();
    const answer = await readFile(answerFile, "utf8");
    const error = await readFile(errorFile, "utf8");
    const sourceBefore = JSON.parse(await readFile(sourceSnapshotPath(runDirectory), "utf8")) as {
      readonly digest: string;
      readonly entries: readonly TreeEntry[];
    };
    const sourceAfter = await captureSourceSnapshot(state.repoRoot);
    const mutation = sourceMutation(sourceBefore.entries, sourceAfter.entries);
    const sourceUnchanged = sourceBefore.digest === sourceAfter.digest;
    if (!sourceUnchanged) {
      await atomicWrite(
        sourceMutationPath(runDirectory),
        `${JSON.stringify(
          {
            beforeDigest: sourceBefore.digest,
            afterDigest: sourceAfter.digest,
            ...mutation,
          },
          null,
          2,
        )}\n`,
      );
    }
    const summary = parseSummary(answer);
    const question = parseQuestion(answer);
    const providerFailure =
      question === undefined
        ? classifyProviderFailure(`${answer}\n${error}`)
        : undefined;
    const scratchWorkspace =
      (await readStructuredScratchWorkspace(runDirectory)) ??
      discoverScratchWorkspace(answer) ??
      state.scratchWorkspace;
    const evalRuns = await readEvalRunRecords(runDirectory);
    const attempt: AttemptRecord = {
      answerFile,
      durationMs: Date.parse(endedAt) - Date.parse(startedAt),
      endedAt,
      errorFile,
      exitCode,
      number: attemptNumber,
      startedAt,
      ...(summary === undefined ? {} : { summary }),
    };
    const attempts = [...state.attempts, attempt];
    const status: RunStatus = !sourceUnchanged
      ? "failed"
      : question !== undefined
        ? "waiting"
        : exitCode === 0
          ? "completed"
          : "failed";
    const next: SpawnState = {
      ...withoutActiveChild(state),
      ...(question === undefined ? {} : { activeQuestion: question }),
      attempts,
      ...(scratchWorkspace === undefined ? {} : { scratchWorkspace }),
      status,
      updatedAt: endedAt,
    };
    await persistState(next);
    await atomicWrite(stepsPath(runDirectory), renderSteps(next));
    const totals = attemptTotals(attempts);
    const evalTotals = evalRunTotals(evalRuns);
    const evalCostUsd =
      evalTotals.candidateCostUsd === undefined && evalTotals.judgeCostUsd === undefined
        ? undefined
        : (evalTotals.candidateCostUsd ?? 0) + (evalTotals.judgeCostUsd ?? 0);
    writeJson({
      ok: exitCode === 0,
      status,
      runDirectory,
      answer: replaceBakeoff(answer),
      error,
      ...(question === undefined ? {} : questionRelay(question)),
      attempt,
      attemptTotals: totals,
      evalRunTotals: evalTotals,
      evalRuns,
      costTable: renderCostTable({
        attempts,
        ...(evalTotals.candidateCostUsd === undefined
          ? {}
          : { candidateCostUsd: evalTotals.candidateCostUsd }),
        ...(evalTotals.candidateDurationMs === undefined
          ? {}
          : { candidateDurationMs: evalTotals.candidateDurationMs }),
        ...(evalTotals.judgeCostUsd === undefined ? {} : { judgeCostUsd: evalTotals.judgeCostUsd }),
        ...(evalTotals.judgeDurationMs === undefined
          ? {}
          : { judgeDurationMs: evalTotals.judgeDurationMs }),
        stoppedForQuestion: question !== undefined,
        ...(totals.costUsd === undefined ? {} : { totalCostUsd: totals.costUsd }),
        unmeasuredAttempts: totals.unmeasuredAttempts,
      }),
      cheaperRerun: cheaperRerunLine({
        ...(evalCostUsd === undefined ? {} : { evalCostUsd }),
        ...(totals.costUsd === undefined ? {} : { totalCostUsd: totals.costUsd }),
      }),
      sourceTree: {
        afterDigest: sourceAfter.digest,
        beforeDigest: sourceBefore.digest,
        unchanged: sourceUnchanged,
        ...mutation,
      },
      ...(scratchWorkspace === undefined ? {} : { scratchWorkspace }),
      ...(providerFailure === undefined ? {} : { providerFailure }),
    });
    if (status === "failed") process.exitCode = exitCode || SPAWN_EXIT.conflict;
    if (status === "waiting") process.exitCode = SPAWN_EXIT.waiting;
  });
};

const answer = async (parsed: ParsedArgs): Promise<void> => {
  const runDirectory = await resolveRunDirectory(parsed);
  const state = await requireState(runDirectory, `no run exists at ${runDirectory}`);
  if (state.status !== "waiting" || state.activeQuestion === undefined)
    fail("the run is not waiting for an answer");
  const activeQuestion = requireValue(state.activeQuestion, "the run is not waiting for an answer");
  const direct = stringFlag(parsed.flags, "--answer");
  const file = stringFlag(parsed.flags, "--answer-file");
  if (direct !== undefined && file !== undefined)
    fail("use only one of --answer and --answer-file");
  const responseValue = file === undefined ? direct : await readFile(path.resolve(file), "utf8");
  const response = requireValue(responseValue, "answer requires --answer or --answer-file");
  if (response.trim() === "") fail("answer requires --answer or --answer-file");
  if (
    classifySpawnReply({ questionText: activeQuestion.text, reply: response }) === "not-an-answer"
  ) {
    writeJson({
      ok: true,
      accepted: false,
      status: "waiting",
      runDirectory,
      reason: "clarification-or-complaint",
      ...questionRelay(activeQuestion),
    });
    process.exitCode = 75;
    return;
  }
  const task = await readFile(taskPath(runDirectory), "utf8");
  await atomicWrite(
    taskPath(runDirectory),
    `${task.trimEnd()}\n\nRouteKitEval question:\n${activeQuestion.text}\n\nUser answer:\n${response.trim()}\n`,
  );
  const prepared: SpawnState = {
    ...withoutActiveQuestion(state),
    status: "prepared",
    updatedAt: new Date().toISOString(),
  };
  await persistState(prepared);
  await atomicWrite(stepsPath(runDirectory), renderSteps(prepared));
  await run({ command: "run", flags: new Map([["--run-directory", runDirectory]]) });
};

const status = async (parsed: ParsedArgs): Promise<void> => {
  const runDirectory = await resolveRunDirectory(parsed);
  const stateRead = await readState(runDirectory);
  const state = stateRead.state;
  if (state === undefined) {
    const files = await readdir(runDirectory).catch(() => []);
    writeJson({
      ok: true,
      status: files.length === 0 ? "absent" : "invalid",
      runDirectory,
      ...(files.length === 0 ? {} : { files, error: stateRead.error }),
    });
    return;
  }
  const files = await readdir(runDirectory);
  const latest = await stat(statePath(runDirectory));
  writeJson({
    ok: true,
    status: state.status,
    runDirectory,
    ageMs: Date.now() - latest.mtimeMs,
    files,
    state,
    activeChildAlive:
      state.activeChildPid === undefined ? false : processIsAlive(state.activeChildPid),
    attemptTotals: attemptTotals(state.attempts),
    evalRunTotals: evalRunTotals(await readEvalRunRecords(runDirectory)),
  });
};

const help = (): void => {
  process.stdout.write(
    `routekit-eval-engine spawn <command>\n\nCommands:\n  skill\n  manifest\n  prepare [--request <text>|--request-file <path>] [--repo <path>] [--harness pi|claude|codex] [--existing resume|archive|stop]\n  run [--repo <path>|--run-directory <path>]\n  answer --answer <text>|--answer-file <path> [--repo <path>|--run-directory <path>]\n  status [--repo <path>|--run-directory <path>]\n`,
  );
};

export const runSpawnWorkflow = async (args: readonly string[]): Promise<void> => {
  const parsed = parseArgs(args);
  try {
    switch (parsed.command) {
      case "skill":
        process.stdout.write(spawnSkill.endsWith("\n") ? spawnSkill : `${spawnSkill}\n`);
        return;
      case "manifest":
        writeJson({
          ok: true,
          protocolVersion: PROTOCOL_VERSION,
          harness: DEFAULT_HARNESS,
          authorHarnesses: AUTHOR_HARNESSES,
          runModel: DEFAULT_RUN_MODEL,
          judgeModel: DEFAULT_JUDGE_MODEL,
          skills: {
            createEval: { sha256: CREATE_EVAL_SKILL_SHA256 },
            spawnRouteKitEval: { sha256: SPAWN_SKILL_SHA256 },
          },
          host: {
            inferenceOrigin: evalInferenceOrigin(),
            inferenceOriginEnv: EVAL_INFERENCE_ORIGIN_ENV,
            credential: hostCredentialPresent() ? "environment" : "missing",
            credentialEnv: ROUTEKIT_EVAL_BEARER_TOKEN_ENV,
          },
        });
        return;
      case "prepare":
        await prepare(parsed);
        return;
      case "run":
        await run(parsed);
        return;
      case "answer":
        await answer(parsed);
        return;
      case "status":
        await status(parsed);
        return;
      case "help":
      case "--help":
      case "-h":
        help();
        return;
      default:
        fail(`unknown spawn command: ${parsed.command}`);
    }
  } catch (error) {
    writeJson({
      ok: false,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode =
      typeof error === "object" && error !== null && "exitCode" in error
        ? Number(error.exitCode)
        : SPAWN_EXIT.conflict;
  }
};

export const spawnWorkflowInternals = {
  attemptTotals,
  cheaperRerunLine,
  classifyProviderFailure,
  classifySpawnReply,
  copyRepositoryTree,
  discoverScratchWorkspace,
  evalRunTotals,
  isInsideRoot,
  parseQuestion,
  parseQuestionOptions,
  parseSummary,
  renderCostTable,
  replaceBakeoff,
};
