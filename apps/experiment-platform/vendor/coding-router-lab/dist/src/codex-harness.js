import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hydratePromisedSnapshotBlobs } from "./git-snapshot-hydration.js";
import { resolveOpenRouterKey } from "./openrouter.js";
const createSnapshotOnlyRepository = async (sourceRepository, snapshot, destination) => {
    await mkdir(destination, { recursive: true });
    const initialized = await run("git", ["init", "--quiet"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (initialized.exitCode !== 0) {
        throw new Error(`Could not initialize isolated snapshot repository: ${initialized.stderr}`);
    }
    const fetched = await run("git", [
        "-C",
        destination,
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--quiet",
        "--no-tags",
        "--depth=1",
        pathToFileURL(sourceRepository).href,
        snapshot,
    ], {
        cwd: sourceRepository,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (fetched.exitCode !== 0) {
        // A partial-clone source can resolve and read the requested commit while a
        // local-protocol fetch still fails when Git tries to copy promised objects.
        // Fall back to an archive materialization, then reconstruct the exact tree
        // and original commit object in a new object database. This preserves the
        // snapshot-only isolation property without exposing the source repository's
        // refs, object alternates, working tree, or later commits.
        await rm(destination, { recursive: true, force: true });
        await materializeSnapshotOnlyRepository(sourceRepository, snapshot, destination).catch((archiveError) => {
            const detail = archiveError instanceof Error
                ? archiveError.message
                : String(archiveError);
            throw new Error(`Could not fetch isolated snapshot ${snapshot}: ${fetched.stderr}\nArchive fallback failed: ${detail}`);
        });
        return;
    }
    const checkedOut = await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (checkedOut.exitCode !== 0) {
        throw new Error(`Could not check out isolated snapshot ${snapshot}: ${checkedOut.stderr}`);
    }
    const resolved = await run("git", ["rev-parse", "HEAD"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (resolved.exitCode !== 0 || resolved.stdout.trim() !== snapshot) {
        throw new Error(`Isolated snapshot mismatch: expected ${snapshot}, got ${resolved.stdout.trim() || "unresolved"}`);
    }
};
const pipeSnapshotTreeToObjectDatabase = (sourceRepository, snapshot, destination) => new Promise((resolve, reject) => {
    const pack = spawn("git", [
        "-C",
        sourceRepository,
        "pack-objects",
        "--stdout",
        "--revs",
    ], {
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "pipe", "pipe"],
    });
    const index = spawn("git", [
        "-C",
        destination,
        "index-pack",
        "--stdin",
        "--fix-thin",
    ], {
        env: { PATH: process.env.PATH },
        stdio: ["pipe", "ignore", "pipe"],
    });
    let packError = "";
    let indexError = "";
    let packCode = null;
    let indexCode = null;
    let settled = false;
    const finish = () => {
        if (settled ||
            packCode === null ||
            indexCode === null) {
            return;
        }
        settled = true;
        if (packCode === 0 && indexCode === 0)
            resolve();
        else {
            reject(new Error(`git pack-objects exited ${packCode}: ${packError.slice(-4_000)}; git index-pack exited ${indexCode}: ${indexError.slice(-4_000)}`));
        }
    };
    pack.stdout.pipe(index.stdin);
    pack.stderr.on("data", (chunk) => {
        packError += String(chunk);
    });
    index.stderr.on("data", (chunk) => {
        indexError += String(chunk);
    });
    pack.on("error", reject);
    index.on("error", reject);
    pack.stdin.on("error", reject);
    index.stdin.on("error", (error) => {
        if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") {
            reject(error);
        }
    });
    pack.on("close", (code) => {
        packCode = code ?? 1;
        finish();
    });
    index.on("close", (code) => {
        indexCode = code ?? 1;
        finish();
    });
    pack.stdin.end(`${snapshot}^{tree}\n`);
});
export const materializeSnapshotOnlyRepository = async (sourceRepository, snapshot, destination) => {
    await mkdir(destination, { recursive: true });
    const gitDirectory = await run("git", ["-C", sourceRepository, "rev-parse", "--absolute-git-dir"], {
        cwd: sourceRepository,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (gitDirectory.exitCode !== 0) {
        throw new Error(`Could not resolve source git directory: ${gitDirectory.stderr}`);
    }
    const temporaryIndex = `${destination}.snapshot-index`;
    await rm(temporaryIndex, { force: true });
    const indexEnvironment = {
        PATH: process.env.PATH,
        GIT_INDEX_FILE: temporaryIndex,
    };
    try {
        await hydratePromisedSnapshotBlobs(sourceRepository, snapshot);
        const readTree = await run("git", [
            `--git-dir=${gitDirectory.stdout.trim()}`,
            `--work-tree=${destination}`,
            "read-tree",
            snapshot,
        ], {
            cwd: sourceRepository,
            env: indexEnvironment,
            timeoutMs: 60_000,
        });
        if (readTree.exitCode !== 0) {
            throw new Error(`Could not index source snapshot: ${readTree.stderr}`);
        }
        const checkout = await run("git", [
            `--git-dir=${gitDirectory.stdout.trim()}`,
            `--work-tree=${destination}`,
            "checkout-index",
            "--all",
            "--force",
        ], {
            cwd: sourceRepository,
            env: indexEnvironment,
            timeoutMs: 900_000,
        });
        if (checkout.exitCode !== 0) {
            throw new Error(`Could not materialize source snapshot: ${checkout.stderr}`);
        }
    }
    finally {
        await rm(temporaryIndex, { force: true });
    }
    const initialized = await run("git", ["init", "--quiet"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (initialized.exitCode !== 0) {
        throw new Error(`Could not initialize archived snapshot: ${initialized.stderr}`);
    }
    for (const [name, value] of [
        ["core.autocrlf", "false"],
        ["core.filemode", "true"],
        ["core.symlinks", "true"],
    ]) {
        const configured = await run("git", ["config", name, value], {
            cwd: destination,
            env: { PATH: process.env.PATH },
            timeoutMs: 60_000,
        });
        if (configured.exitCode !== 0) {
            throw new Error(`Could not configure archived snapshot ${name}: ${configured.stderr}`);
        }
    }
    // checkout-index above exists only to force a partial clone to hydrate every
    // promised blob. Re-indexing those working-tree bytes would be incorrect:
    // checkout filters such as core.autocrlf can change them. Copy the exact
    // snapshot tree objects into the isolated repository instead.
    await pipeSnapshotTreeToObjectDatabase(sourceRepository, snapshot, destination);
    const expectedTree = await run("git", ["-C", sourceRepository, "rev-parse", `${snapshot}^{tree}`], {
        cwd: sourceRepository,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (expectedTree.exitCode !== 0) {
        throw new Error(`Could not resolve source snapshot tree: ${expectedTree.stderr}`);
    }
    const commit = await run("git", ["-C", sourceRepository, "cat-file", "commit", snapshot], {
        cwd: sourceRepository,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (commit.exitCode !== 0) {
        throw new Error(`Could not read snapshot commit: ${commit.stderr}`);
    }
    const written = await run("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
        stdin: commit.stdout,
    });
    if (written.exitCode !== 0 || written.stdout.trim() !== snapshot) {
        throw new Error(`Archived snapshot commit mismatch: expected ${snapshot}, got ${written.stdout.trim()}`);
    }
    const updatedHead = await run("git", ["update-ref", "HEAD", snapshot], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    if (updatedHead.exitCode !== 0) {
        throw new Error(`Could not bind archived snapshot HEAD: ${updatedHead.stderr}`);
    }
    const reset = await run("git", ["reset", "--hard", "--quiet", "HEAD"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 900_000,
    });
    if (reset.exitCode !== 0) {
        throw new Error(`Could not check out archived snapshot: ${reset.stderr}`);
    }
    const actualHead = await run("git", ["rev-parse", "HEAD"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    const actualTree = await run("git", ["rev-parse", "HEAD^{tree}"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 60_000,
    });
    const status = await run("git", ["status", "--porcelain=v1"], {
        cwd: destination,
        env: { PATH: process.env.PATH },
        timeoutMs: 300_000,
    });
    if (actualHead.exitCode !== 0 ||
        actualHead.stdout.trim() !== snapshot ||
        actualTree.exitCode !== 0 ||
        actualTree.stdout.trim() !== expectedTree.stdout.trim() ||
        status.exitCode !== 0 ||
        status.stdout.trim() !== "") {
        throw new Error([
            `Archived snapshot verification failed.`,
            `Expected HEAD/tree: ${snapshot}/${expectedTree.stdout.trim()}.`,
            `Actual HEAD/tree: ${actualHead.stdout.trim() || "unresolved"}/${actualTree.stdout.trim() || "unresolved"}.`,
            `Status: ${status.stdout.trim() || status.stderr.trim() || "clean"}.`,
        ].join(" "));
    }
};
const run = (command, args, options) => new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        reject(error);
    });
    child.stdin.on("error", (error) => {
        // A subprocess can exit before consuming its complete prompt (for
        // example, after a transient provider/startup failure). EPIPE is then a
        // property of that failed child run, not an unhandled parent-process
        // error. The close handler below preserves stdout/stderr and the exit code
        // so callers can retry or recover completed prior cases safely.
        if (error.code !== "EPIPE" &&
            error.code !== "ERR_STREAM_DESTROYED" &&
            !settled) {
            settled = true;
            clearTimeout(timer);
            reject(error);
        }
    });
    child.on("close", (code) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        let toolCalls = 0;
        const usage = {
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
        };
        for (const line of stdout.split(/\r?\n/u)) {
            try {
                const record = JSON.parse(line);
                if (record.type === "item.completed" &&
                    record.item &&
                    typeof record.item === "object") {
                    const itemType = record.item.type;
                    if (itemType === "command_execution" ||
                        itemType === "function_call" ||
                        itemType === "mcp_tool_call") {
                        toolCalls += 1;
                    }
                }
                if (record.type === "response_item" && record.payload && typeof record.payload === "object" && record.payload.type === "function_call")
                    toolCalls += 1;
                if (record.type === "turn.completed" && record.usage && typeof record.usage === "object") {
                    const turnUsage = record.usage;
                    usage.inputTokens += Number(turnUsage.input_tokens ?? 0);
                    usage.cachedInputTokens += Number(turnUsage.cached_input_tokens ?? 0);
                    usage.cacheWriteInputTokens += Number(turnUsage.cache_write_input_tokens ?? 0);
                    usage.outputTokens += Number(turnUsage.output_tokens ?? 0);
                    usage.reasoningOutputTokens += Number(turnUsage.reasoning_output_tokens ?? 0);
                }
            }
            catch { }
        }
        resolve({ exitCode: code ?? 1, stdout, stderr, durationMs: performance.now() - started, toolCalls, usage });
    });
    child.stdin.end(options.stdin ?? "");
});
export const runCodexReadOnly = async (input) => {
    const temporaryRoot = path.join(process.env.HOME ?? os.tmpdir(), ".codex", "tmp", "coding-router-lab");
    const temporary = path.join(temporaryRoot, `coding-router-codex-${process.pid}-${Date.now()}`);
    await mkdir(temporary, { recursive: true });
    const schemaFile = path.join(temporary, "schema.json");
    const promptFile = path.join(temporary, "prompt.txt");
    const outputFile = path.join(temporary, "final.json");
    const configHome = path.join(temporary, "codex-home");
    const workspace = path.join(temporary, "workspace");
    await mkdir(configHome, { recursive: true });
    await createSnapshotOnlyRepository(input.repository, input.snapshot, workspace).catch(async (error) => {
        await rm(temporary, { recursive: true, force: true });
        throw error;
    });
    await writeFile(schemaFile, JSON.stringify(input.outputSchema), { mode: 0o600 });
    await writeFile(promptFile, input.prompt, { mode: 0o600 });
    await writeFile(path.join(configHome, "config.toml"), [
        `model_provider = "openrouter"`,
        `model = ${JSON.stringify(input.model)}`,
        `model_reasoning_effort = "high"`,
        `web_search = "disabled"`,
        `allow_login_shell = false`,
        "",
        "[shell_environment_policy]",
        `inherit = "core"`,
        `ignore_default_excludes = false`,
        "",
        "[shell_environment_policy.filters]",
        `"OPENROUTER_API_KEY" = "exclude"`,
        "",
        "[model_providers.openrouter]",
        `name = "openrouter"`,
        `base_url = "https://openrouter.ai/api/v1"`,
        "",
        "[model_providers.openrouter.auth]",
        `command = "sh"`,
        `args = ["-c", "echo $OPENROUTER_API_KEY"]`,
        "",
    ].join("\n"), { mode: 0o600 });
    try {
        // The temporary repository contains only the exact pre-task snapshot:
        // later commits and refs are absent from its object database. Codex
        // 0.147's Linux read-only sandbox currently
        // prevents even repository reads on this host, so use the unrestricted
        // process sandbox inside that isolated clone. The prompt forbids writes,
        // approvals are disabled, web search is disabled, secrets are excluded
        // from spawned commands, no surrounding checkout is exposed, and the clone
        // is removed after each call.
        const result = await run("codex", ["exec", "--ignore-rules", "--ephemeral", "--json", "--sandbox", "danger-full-access", "-c", 'approval_policy="never"', "--cd", workspace, "--output-schema", schemaFile, "--output-last-message", outputFile, "-"], {
            cwd: workspace,
            env: { HOME: process.env.HOME, PATH: process.env.PATH, CODEX_HOME: configHome, OPENROUTER_API_KEY: await resolveOpenRouterKey() },
            timeoutMs: input.timeoutMs ?? 300_000,
            stdin: input.prompt,
        });
        try {
            result.finalMessage = await readFile(outputFile, "utf8");
        }
        catch { }
        return result;
    }
    finally {
        await rm(temporary, { recursive: true, force: true });
    }
};
