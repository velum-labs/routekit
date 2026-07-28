import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

export function commandTimeoutMs(label, overrides = {}) {
  const table = {
    ssh: 30_000,
    docker: 120_000,
    npmPublish: 180_000,
    remoteInstall: 600_000,
    remoteAdd: 120_000,
    http: 30_000,
    default: 60_000,
    ...overrides
  };
  return table[label] ?? table.default;
}

export class CleanupStack {
  constructor() {
    this.steps = [];
  }

  add(label, fn) {
    this.steps.push({ label, fn });
  }

  async run(log = () => {}) {
    const errors = [];
    while (this.steps.length > 0) {
      const step = this.steps.pop();
      try {
        await step.fn();
        log(`cleanup ok: ${step.label}`);
      } catch (error) {
        errors.push(
          `${step.label}: ${error instanceof Error ? error.message : String(error)}`
        );
        log(`cleanup failed: ${step.label}`);
      }
    }
    return errors;
  }
}

export function runCaptured(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = commandTimeoutMs("default"),
    input,
    label = `${command} ${args.join(" ")}`
  } = options;
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      settle(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const settle = (error, code = 1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(Object.assign(error, { stdout, stderr, code }));
        return;
      }
      resolveRun({ code, stdout, stderr });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => settle(error));
    child.on("close", (code, signal) => {
      if (signal) {
        settle(new Error(`${label} exited from signal ${signal}`), code ?? 1);
        return;
      }
      settle(undefined, code ?? 1);
    });
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export function freePort() {
  return new Promise((resolvePort, reject) => {
    import("node:net").then(({ createServer }) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close(() => reject(new Error("failed to allocate a free port")));
          return;
        }
        const { port } = address;
        server.close((error) => {
          if (error) reject(error);
          else resolvePort(port);
        });
      });
      server.on("error", reject);
    }, reject);
  });
}

export function redactSensitiveText(text, secrets = []) {
  let next = String(text);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    next = next.split(secret).join("[redacted]");
  }
  next = next.replace(/\brk1_[A-Za-z0-9_-]+\b/g, "[redacted]");
  next = next.replace(/\b(Authorization:\s*Bearer\s+)\S+/gi, "$1[redacted]");
  next = next.replace(
    /\b(OPENAI_API_KEY|token|password)=([^\s]+)/gi,
    "$1=[redacted]"
  );
  return next;
}

export function parseJsonOutput(stdout, label = "command") {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} produced no JSON output`);
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning upward.
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function ensureEmptyDir(path) {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

export function requireBinary(name) {
  try {
    execFileSync("sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    throw new Error(`required binary not found on PATH: ${name}`);
  }
}

export async function waitForHttpOk(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs("http");
  const deadline = Date.now() + timeoutMs;
  let lastError = "not attempted";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000)
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

export function createStageLogger() {
  const state = { name: "init", log: [] };
  const api = {
    get name() {
      return state.name;
    },
    get lines() {
      return state.log;
    },
    setStage(name) {
      state.name = name;
      api.log(`stage: ${name}`);
    },
    log(message) {
      const line = `[remote-docker] ${message}`;
      state.log.push(line);
      process.stdout.write(`${line}\n`);
    },
    fail(message, details) {
      const error = new Error(message);
      if (details !== undefined) error.details = details;
      error.stage = state.name;
      throw error;
    }
  };
  return api;
}
