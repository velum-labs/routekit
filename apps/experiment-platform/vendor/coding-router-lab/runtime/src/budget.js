import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, } from "node:fs/promises";
import path from "node:path";
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 25;
const sleep = async (milliseconds) => {
    await new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
};
export class BudgetLedger {
    file;
    ceilingUsd;
    lockTimeoutMs;
    staleLockMs;
    retryDelayMs;
    constructor(file, ceilingUsd, options = {}) {
        this.file = file;
        this.ceilingUsd = ceilingUsd;
        this.lockTimeoutMs =
            options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
        this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
        this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        for (const [field, value] of [
            ["lockTimeoutMs", this.lockTimeoutMs],
            ["staleLockMs", this.staleLockMs],
            ["retryDelayMs", this.retryDelayMs],
        ]) {
            if (!Number.isFinite(value) || value < 0) {
                throw new Error(`Invalid budget ${field}`);
            }
        }
        if (this.staleLockMs === 0) {
            throw new Error("Budget staleLockMs must be greater than zero");
        }
    }
    async read() {
        return this.readUnlocked();
    }
    async readUnlocked() {
        try {
            const state = JSON.parse(await readFile(this.file, "utf8"));
            if (this.ceilingUsd + 1e-9 < state.ceilingUsd) {
                throw new Error(`Configured ceiling $${this.ceilingUsd.toFixed(6)} is below ledger ceiling $${state.ceilingUsd.toFixed(6)}`);
            }
            return this.withRemaining({
                ...state,
                ceilingUsd: this.ceilingUsd,
            });
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            return { ceilingUsd: this.ceilingUsd, committedUsd: 0, spentUsd: 0, updatedAt: new Date().toISOString() };
        }
    }
    async reserve(maximumUsd) {
        if (!Number.isFinite(maximumUsd) || maximumUsd < 0)
            throw new Error("Invalid budget reservation");
        return this.withLock(async () => {
            const state = await this.readUnlocked();
            if (state.spentUsd + state.committedUsd + maximumUsd > state.ceilingUsd + 1e-9) {
                throw new Error(`Budget ceiling exceeded: requested $${maximumUsd.toFixed(6)}, remaining $${(state.ceilingUsd - state.spentUsd - state.committedUsd).toFixed(6)}`);
            }
            const next = this.withRemaining({
                ...state,
                committedUsd: state.committedUsd + maximumUsd,
                updatedAt: new Date().toISOString(),
            });
            await this.writeUnlocked(next);
            return next;
        });
    }
    async settle(reservedUsd, actualUsd) {
        if (!Number.isFinite(reservedUsd) || reservedUsd < 0) {
            throw new Error("Invalid budget settlement reservation");
        }
        if (!Number.isFinite(actualUsd) || actualUsd < 0) {
            throw new Error("Invalid budget settlement");
        }
        return this.withLock(async () => {
            const state = await this.readUnlocked();
            const next = this.withRemaining({
                ...state,
                committedUsd: Math.max(0, state.committedUsd - reservedUsd),
                spentUsd: state.spentUsd + actualUsd,
                updatedAt: new Date().toISOString(),
            });
            await this.writeUnlocked(next);
            if (next.spentUsd > next.ceilingUsd + 1e-9) {
                throw new Error("Budget ceiling exceeded after settlement; actual spend was recorded");
            }
            if (actualUsd > reservedUsd + 1e-9) {
                throw new Error(`Actual cost $${actualUsd.toFixed(6)} exceeded reservation $${reservedUsd.toFixed(6)}; actual spend was recorded`);
            }
            return next;
        });
    }
    async release(reservedUsd) {
        if (!Number.isFinite(reservedUsd) || reservedUsd < 0) {
            throw new Error("Invalid budget release");
        }
        return this.withLock(async () => {
            const state = await this.readUnlocked();
            const next = this.withRemaining({
                ...state,
                committedUsd: Math.max(0, state.committedUsd - reservedUsd),
                updatedAt: new Date().toISOString(),
            });
            await this.writeUnlocked(next);
            return next;
        });
    }
    async withLock(operation) {
        const owner = await this.acquireLock();
        try {
            return await operation();
        }
        finally {
            await this.releaseLock(owner);
        }
    }
    async acquireLock() {
        const lockFile = `${this.file}.lock`;
        await mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
        const startedAt = Date.now();
        while (true) {
            const owner = {
                token: randomUUID(),
                pid: process.pid,
                createdAt: new Date().toISOString(),
            };
            try {
                const handle = await open(lockFile, "wx", 0o600);
                try {
                    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
                    await handle.sync();
                }
                finally {
                    await handle.close();
                }
                return owner;
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
            }
            try {
                const lockStat = await stat(lockFile);
                if (Date.now() - lockStat.mtimeMs > this.staleLockMs) {
                    const staleFile = `${lockFile}.stale-${process.pid}-${randomUUID()}`;
                    try {
                        await rename(lockFile, staleFile);
                        await unlink(staleFile);
                    }
                    catch (error) {
                        const code = error.code;
                        if (code !== "ENOENT")
                            throw error;
                    }
                    continue;
                }
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                continue;
            }
            if (Date.now() - startedAt >= this.lockTimeoutMs) {
                throw new Error(`Timed out waiting for budget ledger lock: ${lockFile}`);
            }
            await sleep(this.retryDelayMs);
        }
    }
    async releaseLock(owner) {
        const lockFile = `${this.file}.lock`;
        try {
            const current = JSON.parse(await readFile(lockFile, "utf8"));
            if (current.token !== owner.token)
                return;
            await unlink(lockFile);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    async writeUnlocked(state) {
        const directory = path.dirname(this.file);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
        const handle = await open(temporary, "wx", 0o600);
        try {
            await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        try {
            await rename(temporary, this.file);
        }
        catch (error) {
            try {
                await unlink(temporary);
            }
            catch {
                // Preserve the original rename error.
            }
            throw error;
        }
    }
    withRemaining(state) {
        return {
            ...state,
            remainingUsd: Math.max(0, state.ceilingUsd - state.spentUsd - state.committedUsd),
        };
    }
}
