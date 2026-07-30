import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  type CreateSessionInput,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  newestResumableSession,
  readSessionRegistry,
  sessionRegistryLockPath,
  sessionRegistryPath,
  sessionRepositoryIdentity,
  sessionsDirectory,
  updateSession
} from "../sessions.js";

async function withRouteKitHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ROUTEKIT_HOME;
  process.env.ROUTEKIT_HOME = home;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ROUTEKIT_HOME;
    else process.env.ROUTEKIT_HOME = previous;
  }
}

function input(cwd: string, overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    tool: "codex",
    resume: { version: 1, kind: "codex", data: { threadId: "native-1" } },
    cwd,
    model: "openai/gpt-5.2-codex",
    reasoning: { mode: "effort", effort: "high" },
    target: { kind: "local" },
    status: "launching",
    ...overrides
  };
}

test("session registry supports locked atomic CRUD without secrets", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-sessions-"));
  const cwd = mkdtempSync(join(tmpdir(), "routekit-session-cwd-"));
  await withRouteKitHome(home, async () => {
    const created = await createSession(
      input(cwd, {
        id: "rks_aaaaaaaaaaaaaaaaaaaaaaaa",
        createdAt: "2026-07-29T10:00:00.000Z"
      })
    );
    assert.equal(created.id, "rks_aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.deepEqual(listSessions(), [created]);
    assert.deepEqual(getSession(created.id), created);

    const updated = await updateSession(created.id, {
      status: "resumable",
      target: { kind: "remote", name: "mini" },
      updatedAt: "2026-07-29T10:01:00.000Z"
    });
    assert.equal(updated.status, "resumable");
    assert.deepEqual(updated.target, { kind: "remote", name: "mini" });
    assert.equal(readSessionRegistry().version, 1);

    const stored = readFileSync(sessionRegistryPath(), "utf8");
    assert.doesNotMatch(stored, /token|credential|prompt|output|transcript/i);
    assert.equal(await deleteSession(created.id), true);
    assert.equal(await deleteSession(created.id), false);
    assert.deepEqual(listSessions(), []);
    assert.equal(existsSync(sessionRegistryLockPath()), false);
  });
});

test("newest resumable selection matches tool and repository with ID tie-breaker", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-sessions-select-"));
  const cwd = mkdtempSync(join(tmpdir(), "routekit-session-select-cwd-"));
  const other = mkdtempSync(join(tmpdir(), "routekit-session-select-other-"));
  await withRouteKitHome(home, async () => {
    const timestamp = "2026-07-29T11:00:00.000Z";
    await createSession(
      input(cwd, {
        id: "rks_bbbbbbbbbbbbbbbbbbbbbbbb",
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "resumable"
      })
    );
    await createSession(
      input(cwd, {
        id: "rks_aaaaaaaaaaaaaaaaaaaaaaaa",
        createdAt: timestamp,
        updatedAt: timestamp,
        status: "resumable",
        resume: { version: 1, kind: "codex", data: { threadId: "native-2" } }
      })
    );
    await createSession(
      input(cwd, {
        id: "rks_cccccccccccccccccccccccc",
        createdAt: "2026-07-29T12:00:00.000Z",
        status: "failed"
      })
    );
    await createSession(
      input(cwd, {
        id: "rks_dddddddddddddddddddddddd",
        createdAt: "2026-07-29T13:00:00.000Z",
        status: "resumable",
        tool: "claude",
        resume: { version: 1, kind: "claude_code", data: { sessionId: "claude-1" } }
      })
    );
    assert.equal(newestResumableSession("codex", cwd)?.id, "rks_aaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(newestResumableSession("claude", cwd)?.id, "rks_dddddddddddddddddddddddd");
    assert.equal(newestResumableSession("codex", other), undefined);
  });
});

test("repository identity canonicalizes cwd and distinguishes Git worktrees", (t) => {
  const base = mkdtempSync(join(tmpdir(), "routekit-session-repo-test-"));
  const root = join(base, "main");
  const worktree = join(base, "worktree");
  const link = join(base, "nested-link");
  const plain = join(base, "plain");
  mkdirSync(root);
  mkdirSync(plain);
  t.after(() => {
    try {
      if (existsSync(worktree)) {
        execFileSync("git", ["-C", root, "worktree", "remove", "--force", worktree]);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "RouteKit Test"]);
  writeFileSync(join(root, "file.txt"), "one\n");
  execFileSync("git", ["-C", root, "add", "file.txt"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "initial"]);
  const nested = join(root, "nested");
  mkdirSync(nested);
  symlinkSync(nested, link);

  const main = sessionRepositoryIdentity(link);
  assert.equal(main.cwd, realpathSync(nested));
  assert.deepEqual(main.repository, { kind: "git-worktree", root: realpathSync(root) });

  execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", worktree]);
  const linked = sessionRepositoryIdentity(worktree);
  assert.equal(linked.repository.kind, "git-worktree");
  assert.notEqual(linked.repository.root, main.repository.root);

  assert.deepEqual(sessionRepositoryIdentity(plain), {
    cwd: realpathSync(plain),
    repository: { kind: "directory", root: realpathSync(plain) }
  });
});

test("sessions subtree, records, and lifecycle lock use private modes", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-sessions-mode-"));
  const cwd = mkdtempSync(join(tmpdir(), "routekit-session-mode-cwd-"));
  await withRouteKitHome(home, async () => {
    let observedLockMode: number | undefined;
    const first = createSession(input(cwd, { id: "rks_aaaaaaaaaaaaaaaaaaaaaaaa" }));
    for (let attempt = 0; attempt < 100 && observedLockMode === undefined; attempt += 1) {
      try {
        observedLockMode = statSync(sessionRegistryLockPath()).mode & 0o777;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    await first;
    assert.equal(statSync(sessionsDirectory()).mode & 0o777, 0o700);
    assert.equal(statSync(sessionRegistryPath()).mode & 0o777, 0o600);
    assert.equal(observedLockMode, 0o600);
  });
});

test("malformed and unsupported registries fail with actionable errors", async () => {
  const home = mkdtempSync(join(tmpdir(), "routekit-sessions-invalid-"));
  await withRouteKitHome(home, async () => {
    mkdirSync(sessionsDirectory(), { recursive: true });
    writeFileSync(sessionRegistryPath(), "{not-json", { mode: 0o600 });
    assert.throws(
      () => readSessionRegistry(),
      (error: unknown) => {
        assert.match(String(error), /not valid JSON/);
        assert.match(String(error), /Move the file aside or remove it/);
        return true;
      }
    );

    writeFileSync(sessionRegistryPath(), JSON.stringify({ version: 2, sessions: [] }));
    assert.throws(() => readSessionRegistry(), /unsupported RouteKit session registry version 2/);

    writeFileSync(
      sessionRegistryPath(),
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: "rks_aaaaaaaaaaaaaaaaaaaaaaaa",
            tool: "codex",
            resume: { version: 1, kind: "codex", data: { threadId: "native-1" } },
            cwd: "/tmp",
            repository: { kind: "directory", root: "/tmp" },
            model: "openai/gpt-5.2-codex",
            target: { kind: "local", token: "secret" },
            createdAt: "2026-07-29T10:00:00.000Z",
            updatedAt: "2026-07-29T10:00:00.000Z",
            status: "resumable"
          }
        ]
      })
    );
    assert.throws(() => readSessionRegistry(), /contains an invalid record/);
  });
});
