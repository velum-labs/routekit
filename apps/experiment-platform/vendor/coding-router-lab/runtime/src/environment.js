import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
const execFileAsync = promisify(execFile);
const command = async (name, args) => {
    try {
        return (await execFileAsync(name, args)).stdout.trim();
    }
    catch {
        return null;
    }
};
export const captureEnvironment = async () => ({
    capturedAt: new Date().toISOString(),
    platform: os.platform(),
    release: os.release(),
    architecture: os.arch(),
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    nodeVersion: process.version,
    npmVersion: await command("npm", ["--version"]),
    codexVersion: await command("codex", ["--version"]),
    gitVersion: await command("git", ["--version"]),
    hostnameHashOmitted: true,
});
