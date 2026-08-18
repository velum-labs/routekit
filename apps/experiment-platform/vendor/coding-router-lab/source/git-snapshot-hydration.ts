import { spawn } from "node:child_process";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const execute = (
  command: string,
  args: readonly string[],
  input = "",
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 900_000,
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code !== "EPIPE" &&
        error.code !== "ERR_STREAM_DESTROYED" &&
        !settled
      ) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
    child.stdin.end(input);
  });

const missingObjectIds = async (
  repository: string,
  snapshot: string,
): Promise<string[]> => {
  const result = await execute(
    "git",
    [
      "-C",
      repository,
      "rev-list",
      "--objects",
      "--missing=print",
      `${snapshot}^{tree}`,
    ],
    "",
    {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not enumerate missing snapshot objects: ${result.stderr}`,
    );
  }
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/u)
        .map((line) => /^\?([0-9a-f]{40,64})$/u.exec(line)?.[1])
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
};

const promisorRemote = async (repository: string): Promise<string | null> => {
  const result = await execute(
    "git",
    [
      "-C",
      repository,
      "config",
      "--get-regexp",
      "^remote\\..*\\.promisor$",
    ],
    "",
    {
      ...process.env,
      GIT_NO_LAZY_FETCH: "1",
    },
    60_000,
  );
  if (result.exitCode !== 0) return null;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^remote\.([^.\s]+)\.promisor\s+true$/iu.exec(line.trim());
    if (match?.[1]) return match[1];
  }
  return null;
};

const transientGitTransportFailure = (detail: string): boolean =>
  /SSL connection timeout|could not fetch .* from promisor remote|RPC failed|remote end hung up|HTTP (?:408|429|5\d\d)/iu.test(
    detail,
  );

/**
 * Batch-fetches every promised blob reachable from an exact snapshot tree.
 *
 * Without this step, checkout-index and ls-tree -l can cause one network
 * fetch per missing blob in a blobless partial clone. The batched fetch is
 * semantically identical, but turns thousands of requests into one pack.
 */
export const hydratePromisedSnapshotBlobs = async (
  repository: string,
  snapshot: string,
): Promise<number> => {
  if (!/^[0-9a-f]{7,64}$/u.test(snapshot)) {
    throw new Error(`Unsafe repository snapshot: ${snapshot}`);
  }
  const missing = await missingObjectIds(repository, snapshot);
  if (missing.length === 0) return 0;
  const remote = await promisorRemote(repository);
  if (!remote) {
    throw new Error(
      `Snapshot ${snapshot} has ${missing.length} missing objects but no promisor remote`,
    );
  }
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await execute(
      "git",
      [
        "-C",
        repository,
        "-c",
        "fetch.negotiationAlgorithm=noop",
        "fetch",
        remote,
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        "--filter=blob:none",
        "--stdin",
      ],
      `${missing.join("\n")}\n`,
    );
    if (result.exitCode === 0) {
      const remaining = await missingObjectIds(repository, snapshot);
      if (remaining.length === 0) return missing.length;
      lastError = `${remaining.length} promised objects remain after fetch`;
    } else {
      lastError = result.stderr;
    }
    if (
      attempt === 2 ||
      (lastError && !transientGitTransportFailure(lastError))
    ) {
      break;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, 1_000 * 2 ** attempt),
    );
  }
  throw new Error(
    `Could not hydrate promised objects for snapshot ${snapshot}: ${lastError}`,
  );
};
