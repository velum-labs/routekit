/**
 * Host CLI and SSH session adapters for the remote Docker lifecycle suite.
 */
import { spawn } from "node:child_process";

import { commandTimeoutMs, parseJsonOutput, runCaptured } from "./process.mjs";
import { withRemotePath } from "./ssh.mjs";

export function createClientEnv(home, stateHome) {
  return {
    ...process.env,
    HOME: home,
    ROUTEKIT_HOME: stateHome,
    ROUTEKIT_NO_SUPERVISOR: "1",
    ROUTEKIT_PORTLESS: "0",
    PORTLESS: "0",
    NO_COLOR: "1",
    ROUTEKIT_NO_TUI: "1",
    GIT_SSH_COMMAND: undefined,
    SSH_AUTH_SOCK: undefined,
    PATH: process.env.PATH
  };
}

/**
 * @param {{
 *   root: string;
 *   cliEntry: string;
 *   fail: (message: string, details?: unknown) => never;
 *   run?: typeof runCaptured;
 * }} deps
 */
export function createRoutekitCli(deps) {
  const { root, cliEntry, fail, run = runCaptured } = deps;

  /**
   * @param {string[]} args
   * @param {NodeJS.ProcessEnv} env
   * @param {{
   *   cwd?: string;
   *   timeoutMs?: number;
   *   input?: string;
   *   allowFailure?: boolean;
   * }} [options]
   */
  return async function runCli(args, env, options = {}) {
    const result = await run(process.execPath, [cliEntry, ...args], {
      cwd: options.cwd ?? root,
      env,
      timeoutMs: options.timeoutMs ?? commandTimeoutMs("default"),
      input: options.input,
      label: `routekit ${args.join(" ")}`
    });
    if (options.allowFailure === true) return result;
    if (result.code !== 0) {
      fail(`routekit ${args.join(" ")} failed`, {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return result;
  };
}

/**
 * @param {{
 *   fail: (message: string, details?: unknown) => never;
 *   run?: typeof runCaptured;
 * }} deps
 */
export function createSshRunner(deps) {
  const { fail, run = runCaptured } = deps;

  /**
   * @param {string} alias
   * @param {string} remoteCommand
   * @param {{
   *   configPath: string;
   *   extraArgs?: string[];
   *   timeoutMs?: number;
   *   input?: string;
   *   allowFailure?: boolean;
   *   withPath?: boolean;
   * }} options
   */
  return async function ssh(alias, remoteCommand, options) {
    const command =
      options.withPath === true ? withRemotePath(remoteCommand) : remoteCommand;
    const args = [
      "-F",
      options.configPath,
      ...(options.extraArgs ?? []),
      alias,
      command
    ];
    const result = await run("ssh", args, {
      timeoutMs: options.timeoutMs ?? commandTimeoutMs("ssh"),
      input: options.input,
      label: `ssh ${alias} ${remoteCommand}`
    });
    if (options.allowFailure === true) return result;
    if (result.code !== 0) {
      fail(`ssh ${alias} failed: ${remoteCommand}`, {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr
      });
    }
    return result;
  };
}

/**
 * @param {string} url
 * @param {{
 *   method?: string;
 *   token?: string;
 *   body?: unknown;
 *   timeoutMs?: number;
 * }} [options]
 */
export async function httpJson(url, options = {}) {
  const headers = {
    accept: "application/json",
    ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {})
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(url, {
    method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
  });
  const text = await response.text();
  let json;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, ok: response.ok, text, json };
}

/**
 * Open an SSH local-forward tunnel and return a handle that can be killed.
 * @param {{
 *   configPath: string;
 *   alias: string;
 *   localPort: number;
 *   remotePort?: number;
 * }} input
 */
export function openLocalForwardTunnel(input) {
  const remotePort = input.remotePort ?? 8080;
  const child = spawn(
    "ssh",
    [
      "-F",
      input.configPath,
      "-N",
      "-L",
      `127.0.0.1:${input.localPort}:127.0.0.1:${remotePort}`,
      input.alias
    ],
    { stdio: "ignore" }
  );
  return {
    child,
    stop() {
      if (child.pid) child.kill("SIGTERM");
    }
  };
}

export { parseJsonOutput };
