import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "./hash.ts";
import type { SilverLabelV1, TaskEpisode } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface CanonicalTraceSource {
  taskEpisodeId: string;
  sourceTrace: string;
  sourcePass: number;
  isolationMode: "shared-object-worktree" | "snapshot-only-clone";
}

interface CommandEvent {
  command: string;
  output: string;
  exitCode: number | null;
  status: string;
}

interface TraceDocument {
  pass: number;
  stdout: string;
  stderr: string;
  finalMessage: string;
  toolCalls: number;
}

type TraceIsolationMode = CanonicalTraceSource["isolationMode"];

export interface OracleTraceAudit {
  schemaVersion: 1;
  generatedAt: string;
  labels: number;
  canonicalPasses: number;
  tracesAudited: number;
  traceIsolation: {
    sharedObjectWorktree: number;
    snapshotOnlyClone: number;
  };
  commandExecutions: number;
  webSearchEvents: number;
  findings: {
    missingTraceSources: CanonicalTraceSource[];
    missingEpisodes: string[];
    sourcePassMismatches: Array<{
      taskEpisodeId: string;
      expectedPass: number;
      tracePass: number;
    }>;
    parseErrors: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      line: number;
    }>;
    failedCommands: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      command: string;
      exitCode: number | null;
      status: string;
    }>;
    networkEvents: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      detail: string;
    }>;
    mutationCommands: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      command: string;
    }>;
    futureRefCommands: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      command: string;
      isolatedAllRefsEvidence: boolean;
    }>;
    externalPathCommands: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      command: string;
      isolationMode: TraceIsolationMode;
    }>;
    secretFindings: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      field: "stdout" | "stderr" | "finalMessage";
      kind: string;
    }>;
    workspaceMismatches: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      observedPath: string;
    }>;
    snapshotMismatches: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      expectedSnapshot: string;
      observedHead: string | null;
    }>;
    sourceHashesOutsideSnapshotHistory: Array<{
      taskEpisodeId: string;
      sourceTrace: string;
      expectedSnapshot: string;
      referencedHash: string;
    }>;
  };
  gates: Array<{
    gate: string;
    passed: boolean;
    detail: string;
  }>;
  ready: boolean;
  notes: string[];
}

const commandProgram = (command: string): string => {
  const shellMatch = /^\/bin\/bash\s+-[a-z]+\s+([\s\S]+)$/u.exec(command);
  if (!shellMatch?.[1]) return command;
  const value = shellMatch[1].trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    /*
     * Decode only the escapes that a POSIX shell consumes inside a
     * double-quoted `bash -c` argument. This makes nested quoted grep
     * expressions visible to the quote-aware command splitter below without
     * altering ordinary regex escapes such as `\b` or `\n`.
     */
    return value
      .slice(1, -1)
      .replace(/\\(["\\$`])/gu, "$1");
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
};

const splitShellCommand = (command: string): string[] => {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  const flush = (): void => {
    const value = current.trim();
    if (value) segments.push(value);
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "\n" || character === ";") {
      flush();
      continue;
    }
    if (character === "|" || character === "&") {
      flush();
      if (command[index + 1] === character) index += 1;
      continue;
    }
    current += character;
  }
  flush();
  return segments;
};

const activeCommandSegments = (command: string): string[] =>
  splitShellCommand(commandProgram(command))
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) =>
      segment
        .replace(/^(?:if|then|elif|else|while|until|do)\s+/u, "")
        .replace(/^(?:!\s*)/u, "")
        .trim()
    );

const commandName = (segment: string): string | undefined => {
  let value = segment;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(value)) {
    value = value.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s*/u, "");
  }
  const match = /^(?:command\s+)?([A-Za-z0-9_./-]+)/u.exec(value);
  return match?.[1]?.split("/").at(-1);
};

const shellControlWords = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "for",
  "select",
  "in",
  "function",
  "time",
  "coproc",
]);

const isExecutableCommandSegment = (segment: string): boolean => {
  const name = commandName(segment);
  return Boolean(name && !shellControlWords.has(name));
};

const isNetworkCommand = (command: string): boolean => {
  const networkCommands = new Set([
    "curl",
    "wget",
    "ssh",
    "scp",
    "sftp",
    "rsync",
    "nc",
    "ncat",
    "telnet",
    "ftp",
  ]);
  return activeCommandSegments(command)
    .filter(isExecutableCommandSegment)
    .some((segment) => networkCommands.has(commandName(segment) ?? ""));
};

const isMutationCommand = (command: string): boolean => {
  const mutatingCommands = new Set([
    "rm",
    "mv",
    "cp",
    "touch",
    "mkdir",
    "rmdir",
    "chmod",
    "chown",
    "ln",
    "install",
    "tee",
    "truncate",
    "dd",
    "patch",
  ]);
  for (
    const segment of activeCommandSegments(command).filter(
      isExecutableCommandSegment,
    )
  ) {
    const name = commandName(segment);
    if (name && mutatingCommands.has(name)) return true;
    if (/^(?:sed|perl)\s+-[^\s]*i/u.test(segment)) return true;
    /*
     * `git branch` without a mutation option is a read-only ref listing
     * command. Treat only branch creation/deletion/move/copy/edit operations
     * as mutations; options such as `--all`, `--contains`, `--list`, and
     * `--no-color` are safe repository inspection.
     */
    if (/^git\s+branch\b/u.test(segment)) {
      const argumentsText = segment.replace(/^git\s+branch\b/u, "").trim();
      const mutatingOption =
        /(?:^|\s)(?:-[dDmMcCf]|--delete|--move|--copy|--edit-description|--set-upstream-to|--unset-upstream|--track|--no-track|--create-reflog|--force|--recurse-submodules)(?:[=\s]|$)/u.test(
          argumentsText,
        );
      const readOnlyOptionsWithValues = new Set([
        "--contains",
        "--no-contains",
        "--merged",
        "--no-merged",
        "--points-at",
        "--format",
        "--sort",
        "--color",
        "--column",
        "--abbrev",
        "--list",
        "-l",
      ]);
      const tokens = argumentsText.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
      let positionalArgument = false;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (!token.startsWith("-")) {
          positionalArgument = true;
          continue;
        }
        const option = token.split("=")[0]!;
        if (
          readOnlyOptionsWithValues.has(option) &&
          !token.includes("=")
        ) {
          index += 1;
        }
      }
      if (mutatingOption || positionalArgument) return true;
    }
    if (
      /^git\s+(?:add|checkout|switch|reset|clean|commit|merge|rebase|cherry-pick|revert|fetch|pull|push|clone|init|gc|repack)\b/u.test(
        segment,
      )
    ) {
      return true;
    }
    if (/^git\s+tag\b/u.test(segment)) {
      const argumentsText = segment.replace(/^git\s+tag\b/u, "").trim();
      const mutatingOption =
        /(?:^|\s)(?:-[adfsuemF]|--annotate|--delete|--force|--sign|--local-user|--edit|--message|--file|--cleanup|--create-reflog)(?:[=\s]|$)/u.test(
          argumentsText,
        );
      const explicitReadOnlyMode =
        /(?:^|\s)(?:-l|--list|-v|--verify)(?:[=\s]|$)/u.test(
          argumentsText,
        );
      const readOnlyOptionsWithValues = new Set([
        "--list",
        "--contains",
        "--no-contains",
        "--points-at",
        "--merged",
        "--no-merged",
        "--sort",
        "--color",
        "--format",
        "--column",
      ]);
      const tokens = argumentsText.match(/"[^"]*"|'[^']*'|\S+/gu) ?? [];
      let positionalArgument = false;
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (!token.startsWith("-")) {
          positionalArgument = true;
          continue;
        }
        const option = token.split("=")[0]!;
        if (
          readOnlyOptionsWithValues.has(option) &&
          !token.includes("=")
        ) {
          index += 1;
        }
      }
      if (
        mutatingOption ||
        (positionalArgument && !explicitReadOnlyMode)
      ) {
        return true;
      }
    }
    if (
      /^(?:npm|pnpm|yarn|bun)\s+(?:install|publish|add|remove)\b/u.test(
        segment,
      )
    ) {
      return true;
    }
  }
  return false;
};

const referencesFutureRefs = (command: string): boolean =>
  /\bgit\s+(?:show|log|rev-list|for-each-ref|show-ref|branch|tag)\b[^;&|\n]*(?:--all|refs\/)|\bgit\s+(?:reflog|fsck)\b|\.git\/(?:objects|refs|logs)/iu.test(
    command,
  );

const referencesExternalPath = (command: string): boolean =>
  /(?:^|[\s"'=(])(?:\/home\/|\/Users\/|~\/|\.\.\/)/u.test(
    commandProgram(command),
  );

const isolatedAllRefsEvidence = (
  output: string,
  expectedSnapshot: string,
): boolean => {
  const commitLines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{7,40}(?:\s|\))/iu.test(line));
  if (commitLines.length === 0) return true;
  return commitLines.every((line) =>
    expectedSnapshot.toLowerCase().startsWith(
      (/^[0-9a-f]{7,40}/iu.exec(line)?.[0] ?? "").toLowerCase(),
    )
  );
};

const secretPatterns: Array<[string, RegExp]> = [
  ["openrouter_or_api_key", /sk-(?:or-)?[A-Za-z0-9_-]{12,}/u],
  ["private_key", /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/u],
  [
    "literal_bearer_credential",
    /authorization\s*:\s*bearer\s+(?!\$|\$\{|\[)[A-Za-z0-9._~+/=-]{12,}/iu,
  ],
  [
    "credential_assignment",
    /(?:api[_-]?key|password|secret|token)\s*[=:]\s*["']?(?!\$|\$\{|\[)[A-Za-z0-9_\-./+]{24,}(?![A-Za-z0-9_\-./+])(?!\s*\()/iu,
  ],
];

const hashCandidates = (command: string): string[] =>
  [...command.matchAll(/\b[0-9a-f]{7,40}\b/giu)].map((match) => match[0]!);

const isIsolatedWorkspacePath = (value: string): boolean =>
  /\/\.codex\/tmp\/coding-router-lab\/coding-router-codex-[^/]+\/workspace(?:\/|$)/u.test(
    value,
  );

const observedWorkingDirectories = (commands: CommandEvent[]): string[] =>
  commands
    .filter((command) => {
      const firstSegment = activeCommandSegments(command.command)[0];
      return commandName(firstSegment ?? "") === "pwd";
    })
    .filter(
      (command) =>
        command.status === "completed" && command.exitCode === 0,
    )
    .map((command) => command.output.split(/\r?\n/u)[0]?.trim())
    .filter((value): value is string => Boolean(value?.startsWith("/")));

const safeSnapshotOnlyExternalPath = (
  command: string,
  observedWorkingDirectoriesForTrace: string[],
): boolean => {
  if (
    observedWorkingDirectoriesForTrace.length === 0 ||
    observedWorkingDirectoriesForTrace.some(
      (directory) => !isIsolatedWorkspacePath(directory),
    )
  ) {
    return false;
  }
  const program = commandProgram(command);
  if (/(?:^|[\s"'=(])\.\.\//u.test(program)) return false;
  const externalPaths =
    program.match(
      /(?:\/home\/[^/\s"'=()]+|\/Users\/[^/\s"'=()]+|~)\/[^\s"'=()]*/gu,
    ) ?? [];
  return (
    externalPaths.length > 0 &&
    externalPaths.every((externalPath) =>
      /^(?:\/home\/[^/]+|\/Users\/[^/]+|~)\/\.codex\/tmp\/coding-router-lab\/coding-router-codex-[^/]+\/workspace(?:\/|$)/u.test(
        externalPath,
      )
    )
  );
};

const parseCommandEvents = (
  trace: TraceDocument,
  taskEpisodeId: string,
  sourceTrace: string,
  parseErrors: OracleTraceAudit["findings"]["parseErrors"],
): { commands: CommandEvent[]; webSearchEvents: number } => {
  const commands: CommandEvent[] = [];
  let webSearchEvents = 0;
  for (const [lineIndex, line] of trace.stdout.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const item =
        record.item && typeof record.item === "object"
          ? record.item as Record<string, unknown>
          : undefined;
      if (
        record.type === "item.completed" &&
        item?.type === "command_execution"
      ) {
        commands.push({
          command: String(item.command ?? ""),
          output: String(item.aggregated_output ?? ""),
          exitCode:
            typeof item.exit_code === "number" ? item.exit_code : null,
          status: String(item.status ?? ""),
        });
      }
      if (record.type === "item.completed" && item?.type === "web_search") {
        webSearchEvents += 1;
      }
    } catch {
      parseErrors.push({
        taskEpisodeId,
        sourceTrace,
        line: lineIndex + 1,
      });
    }
  }
  return { commands, webSearchEvents };
};

export const auditOracleTraces = async (input: {
  labels: SilverLabelV1[];
  canonicalPasses: SilverLabelV1[];
  traceSources: CanonicalTraceSource[];
  episodes: TaskEpisode[];
  repository: string;
}): Promise<OracleTraceAudit> => {
  const episodesById = new Map(
    input.episodes.map((episode) => [episode.id, episode]),
  );
  const findings: OracleTraceAudit["findings"] = {
    missingTraceSources: [],
    missingEpisodes: [],
    sourcePassMismatches: [],
    parseErrors: [],
    failedCommands: [],
    networkEvents: [],
    mutationCommands: [],
    futureRefCommands: [],
    externalPathCommands: [],
    secretFindings: [],
    workspaceMismatches: [],
    snapshotMismatches: [],
    sourceHashesOutsideSnapshotHistory: [],
  };
  if (input.traceSources.length !== input.canonicalPasses.length) {
    throw new Error(
      `Trace source map has ${input.traceSources.length} records for ${input.canonicalPasses.length} canonical passes`,
    );
  }
  const labelIds = new Set(input.labels.map((label) => label.taskEpisodeId));
  const passIds = new Set(
    input.canonicalPasses.map((label) => label.taskEpisodeId),
  );
  if (
    labelIds.size !== passIds.size ||
    [...labelIds].some((id) => !passIds.has(id))
  ) {
    throw new Error("Canonical pass file and adjudicated label file disagree");
  }

  let tracesAudited = 0;
  let sharedObjectWorktree = 0;
  let snapshotOnlyClone = 0;
  let commandExecutions = 0;
  let webSearchEvents = 0;
  for (const [index, source] of input.traceSources.entries()) {
    const pass = input.canonicalPasses[index]!;
    if (pass.taskEpisodeId !== source.taskEpisodeId) {
      throw new Error(
        `Trace source ${index + 1} maps ${source.taskEpisodeId} to canonical pass ${pass.taskEpisodeId}`,
      );
    }
    const episode = episodesById.get(source.taskEpisodeId);
    if (!episode) {
      findings.missingEpisodes.push(source.taskEpisodeId);
      continue;
    }
    let trace: TraceDocument;
    try {
      trace = JSON.parse(
        await readFile(source.sourceTrace, "utf8"),
      ) as TraceDocument;
    } catch {
      findings.missingTraceSources.push(source);
      continue;
    }
    tracesAudited += 1;
    if (source.isolationMode === "snapshot-only-clone") {
      snapshotOnlyClone += 1;
    } else {
      sharedObjectWorktree += 1;
    }
    if (trace.pass !== source.sourcePass) {
      findings.sourcePassMismatches.push({
        taskEpisodeId: source.taskEpisodeId,
        expectedPass: source.sourcePass,
        tracePass: trace.pass,
      });
    }
    const parsed = parseCommandEvents(
      trace,
      source.taskEpisodeId,
      source.sourceTrace,
      findings.parseErrors,
    );
    commandExecutions += parsed.commands.length;
    webSearchEvents += parsed.webSearchEvents;
    if (parsed.webSearchEvents > 0) {
      findings.networkEvents.push({
        taskEpisodeId: source.taskEpisodeId,
        sourceTrace: source.sourceTrace,
        detail: `${parsed.webSearchEvents} web-search event(s)`,
      });
    }

    const completedOutputs = parsed.commands.map((command) => command.output);
    const observedHead =
      completedOutputs
        .flatMap((output) => output.split(/\r?\n/u))
        .map((line) => line.trim())
        .map((line) => /^([0-9a-f]{7,40})\s+\(?(?:grafted,\s*)?HEAD\)?\b/iu.exec(line)?.[1])
        .find(Boolean) ?? null;
    if (
      observedHead &&
      !episode.repositorySnapshot.toLowerCase().startsWith(
        observedHead.toLowerCase(),
      )
    ) {
      findings.snapshotMismatches.push({
        taskEpisodeId: source.taskEpisodeId,
        sourceTrace: source.sourceTrace,
        expectedSnapshot: episode.repositorySnapshot,
        observedHead,
      });
    }
    const observedWorkingDirectoriesForTrace =
      observedWorkingDirectories(parsed.commands);

    for (const command of parsed.commands) {
      if (command.status !== "completed" || command.exitCode !== 0) {
        findings.failedCommands.push({
          taskEpisodeId: source.taskEpisodeId,
          sourceTrace: source.sourceTrace,
          command: command.command,
          exitCode: command.exitCode,
          status: command.status,
        });
      }
      if (isNetworkCommand(command.command)) {
        findings.networkEvents.push({
          taskEpisodeId: source.taskEpisodeId,
          sourceTrace: source.sourceTrace,
          detail: command.command,
        });
      }
      if (isMutationCommand(command.command)) {
        findings.mutationCommands.push({
          taskEpisodeId: source.taskEpisodeId,
          sourceTrace: source.sourceTrace,
          command: command.command,
        });
      }
      if (referencesFutureRefs(command.command)) {
        findings.futureRefCommands.push({
          taskEpisodeId: source.taskEpisodeId,
          sourceTrace: source.sourceTrace,
          command: command.command,
          isolatedAllRefsEvidence: isolatedAllRefsEvidence(
            command.output,
            episode.repositorySnapshot,
          ),
        });
      }
      if (
        referencesExternalPath(command.command) &&
        !(
          source.isolationMode === "snapshot-only-clone" &&
          safeSnapshotOnlyExternalPath(
            command.command,
            observedWorkingDirectoriesForTrace,
          )
        )
      ) {
        findings.externalPathCommands.push({
          taskEpisodeId: source.taskEpisodeId,
          sourceTrace: source.sourceTrace,
          command: command.command,
          isolationMode: source.isolationMode,
        });
      }
      if (source.isolationMode === "shared-object-worktree") {
        for (const hash of hashCandidates(command.command)) {
          if (episode.repositorySnapshot.startsWith(hash)) continue;
          try {
            await execFileAsync(
              "git",
              [
                "-C",
                input.repository,
                "merge-base",
                "--is-ancestor",
                hash,
                episode.repositorySnapshot,
              ],
            );
          } catch {
            findings.sourceHashesOutsideSnapshotHistory.push({
              taskEpisodeId: source.taskEpisodeId,
              sourceTrace: source.sourceTrace,
              expectedSnapshot: episode.repositorySnapshot,
              referencedHash: hash,
            });
          }
        }
      }
    }

    for (const observedPath of observedWorkingDirectoriesForTrace) {
      if (!isIsolatedWorkspacePath(observedPath)) {
        findings.workspaceMismatches.push({
          taskEpisodeId: source.taskEpisodeId,
          sourceTrace: source.sourceTrace,
          observedPath,
        });
      }
    }

    const fields: Array<["stdout" | "stderr" | "finalMessage", string]> = [
      ...parsed.commands.map(
        (command): ["stdout", string] => [
          "stdout",
          `${command.command}\n${command.output}`,
        ],
      ),
      ["stderr", trace.stderr],
      ["finalMessage", trace.finalMessage],
    ];
    for (const [field, text] of fields) {
      for (const [kind, pattern] of secretPatterns) {
        if (pattern.test(text)) {
          findings.secretFindings.push({
            taskEpisodeId: source.taskEpisodeId,
            sourceTrace: source.sourceTrace,
            field,
            kind,
          });
        }
      }
    }
  }

  const unsafeFutureRefs = findings.futureRefCommands.filter(
    (finding) => !finding.isolatedAllRefsEvidence,
  );
  const gates = [
    {
      gate: "all-canonical-traces-present",
      passed:
        tracesAudited === input.canonicalPasses.length &&
        findings.missingTraceSources.length === 0,
      detail: `${tracesAudited}/${input.canonicalPasses.length}`,
    },
    {
      gate: "trace-json-parses",
      passed: findings.parseErrors.length === 0,
      detail: `${findings.parseErrors.length} parse errors`,
    },
    {
      gate: "no-web-or-network-tools",
      passed:
        webSearchEvents === 0 && findings.networkEvents.length === 0,
      detail: `${webSearchEvents} web-search events, ${findings.networkEvents.length} network findings`,
    },
    {
      gate: "no-mutation-commands",
      passed: findings.mutationCommands.length === 0,
      detail: `${findings.mutationCommands.length} findings`,
    },
    {
      gate: "no-paths-outside-isolated-workspace",
      passed:
        findings.externalPathCommands.length === 0 &&
        findings.workspaceMismatches.length === 0,
      detail: `${findings.externalPathCommands.length} external command paths, ${findings.workspaceMismatches.length} workspace mismatches`,
    },
    {
      gate: "no-secret-material",
      passed: findings.secretFindings.length === 0,
      detail: `${findings.secretFindings.length} findings`,
    },
    {
      gate: "snapshot-head-consistent",
      passed: findings.snapshotMismatches.length === 0,
      detail: `${findings.snapshotMismatches.length} mismatches`,
    },
    {
      gate: "referenced-commits-contained-in-snapshot-history",
      passed: findings.sourceHashesOutsideSnapshotHistory.length === 0,
      detail: `${findings.sourceHashesOutsideSnapshotHistory.length} outside-history hashes`,
    },
    {
      gate: "all-ref-inspection-confined-to-shallow-snapshot",
      passed: unsafeFutureRefs.length === 0,
      detail: `${findings.futureRefCommands.length} all-ref/history commands, ${unsafeFutureRefs.length} unsafe outputs`,
    },
    {
      gate: "canonical-trace-isolation-recorded",
      passed: sharedObjectWorktree + snapshotOnlyClone === tracesAudited,
      detail: `${sharedObjectWorktree} legacy shared-object worktree, ${snapshotOnlyClone} snapshot-only clone`,
    },
  ];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    labels: input.labels.length,
    canonicalPasses: input.canonicalPasses.length,
    tracesAudited,
    traceIsolation: {
      sharedObjectWorktree,
      snapshotOnlyClone,
    },
    commandExecutions,
    webSearchEvents,
    findings,
    gates,
    ready: gates.every((gate) => gate.passed),
    notes: [
      "The canonical source map is private because it links adjudicated passes to full private traces.",
      "Legacy shared-object worktree traces are accepted only when every explicit commit is in the episode snapshot history and every all-ref/history command's captured output contains no different commit.",
      "Snapshot-only clones contain only the exact shallow episode snapshot, so later refs and objects are unavailable even when a command includes --all.",
      `Audit source-map SHA-256: ${sha256(JSON.stringify(input.traceSources))}`,
    ],
  };
};
