import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_NAME = "T3 Code (Alpha)";
const APP_EXECUTABLE = "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)";
const DEBUG_PORT = 9224;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function appPids() {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+1\s+(.+)$/))
    .filter((match) => match?.[2]?.startsWith(APP_EXECUTABLE))
    .map((match) => Number(match[1]));
}

async function stopDesktopApp() {
  const pids = await appPids();
  for (const pid of pids) process.kill(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await appPids()).length === 0) return;
    await delay(200);
  }
  const remaining = await appPids();
  for (const pid of remaining) process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 25; attempt += 1) {
    if ((await appPids()).length === 0) return;
    await delay(200);
  }
  throw new Error("T3 Code did not exit after terminating its exact desktop process");
}

async function debugPage() {
  const endpoint = `http://127.0.0.1:${DEBUG_PORT}/json/list`;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(endpoint)).json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The desktop process is still starting.
    }
    await delay(250);
  }
  throw new Error("T3 Code desktop debugging endpoint did not become ready");
}

async function cdpClient(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

async function evaluate(client, expression) {
  const response = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ?? "T3 Code evaluation failed"
    );
  }
  return response.result?.value;
}

async function waitForRemote(client, host, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const quotedHost = JSON.stringify(host);
  while (Date.now() < deadline) {
    const state = await evaluate(
      client,
      `(() => {
        const heading = [...document.querySelectorAll("h3")].find(
          (element) => element.innerText.trim() === ${quotedHost}
        );
        if (!heading) return { found: false };
        let row = heading;
        for (let depth = 0; depth < 7 && row; depth += 1, row = row.parentElement) {
          const text = row.innerText || "";
          if (text.includes("SSH ") && /Disconnect|Connect|Connecting/.test(text)) {
            return { found: true, connected: text.includes("Disconnect"), text };
          }
        }
        return { found: true, connected: false, text: heading.innerText };
      })()`
    );
    if (state?.connected) return state;
    await delay(500);
  }
  throw new Error(`T3 Code did not connect SSH environment ${host}`);
}

async function registerThroughUi(client, host) {
  const quotedHost = JSON.stringify(host);
  await client.call("Runtime.enable");
  await evaluate(client, 'location.hash = "#/settings/connections"');
  await delay(1_500);

  const existing = await evaluate(
    client,
    `(() => [...document.querySelectorAll("h3")].some(
      (element) => element.innerText.trim() === ${quotedHost}
    ))()`
  );
  if (existing) {
    const connected = await evaluate(
      client,
      `(() => {
        const heading = [...document.querySelectorAll("h3")].find(
          (element) => element.innerText.trim() === ${quotedHost}
        );
        let row = heading;
        for (let depth = 0; depth < 7 && row; depth += 1, row = row.parentElement) {
          const button = [...row.querySelectorAll("button")].find(
            (element) => element.innerText.trim() === "Connect"
          );
          if (button) { button.click(); return false; }
          if ([...row.querySelectorAll("button")].some(
            (element) => element.innerText.trim() === "Disconnect"
          )) return true;
        }
        return false;
      })()`
    );
    if (!connected) await waitForRemote(client, host);
    return { action: connected ? "existing" : "connected", host };
  }

  const opened = await evaluate(
    client,
    `(() => {
      const button = [...document.querySelectorAll("button")].find(
        (element) => element.innerText.trim() === "Add environment" ||
          element.getAttribute("aria-label") === "Add environment"
      );
      if (!button) return false;
      button.click();
      return true;
    })()`
  );
  if (!opened) throw new Error("T3 Code Add environment control was not found");
  await delay(500);
  const selectedSsh = await evaluate(
    client,
    `(() => {
      const button = [...document.querySelectorAll("button")].find(
        (element) => element.innerText.trim().startsWith("SSH")
      );
      if (!button) return false;
      button.click();
      return true;
    })()`
  );
  if (!selectedSsh) throw new Error("T3 Code SSH environment option was not found");
  await delay(500);
  const started = await evaluate(
    client,
    `(() => {
      const button = [...document.querySelectorAll("button")]
        .filter((element) => element.innerText.trim() === "Add environment")
        .find((element) =>
          (element.parentElement?.parentElement?.innerText || "").trim().startsWith(${quotedHost})
        );
      if (!button) return false;
      button.click();
      return true;
    })()`
  );
  if (!started) throw new Error(`T3 Code did not discover SSH host ${host}`);
  await waitForRemote(client, host);
  return { action: "registered", host };
}

export async function ensureDesktopSshRemote(host, options = {}) {
  if (options.dryRun) return { action: "would-register", host };
  if (process.platform !== "darwin") throw new Error("T3 Code desktop provisioning requires macOS");
  if (!existsSync(APP_EXECUTABLE)) throw new Error(`${APP_NAME} is not installed`);
  if ((await appPids()).length > 0) {
    throw new Error(
      "quit T3 Code before local provisioning so its desktop connection catalog can be updated safely"
    );
  }

  let client;
  try {
    await execFileAsync("open", [
      "-n",
      "-a",
      APP_NAME,
      "--args",
      `--remote-debugging-port=${DEBUG_PORT}`
    ]);
    const page = await debugPage();
    client = await cdpClient(page.webSocketDebuggerUrl);
    return await registerThroughUi(client, host);
  } finally {
    client?.close();
    try {
      await stopDesktopApp();
    } finally {
      await execFileAsync("open", ["-n", "-a", APP_NAME]);
    }
  }
}
