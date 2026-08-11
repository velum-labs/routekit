import assert from "node:assert/strict";
import test from "node:test";

import type {
  RemoteEnrollmentJournal,
  RemoteRegistry,
  RemoteRegistrySnapshot,
  RemoteRemovalJournal
} from "../remotes.js";
import {
  RemoteEnrollmentTransaction,
  type RemoteEnrollmentTransactionPorts,
  RemoteRemovalTransaction,
  type RemoteTransactionRecoveryPorts,
  recoverRemoteTransaction
} from "../use-cases/remote.js";

const remote = {
  name: "mini",
  gatewayUrl: "https://gateway.example",
  sshHost: "test-host",
  addedAt: "2026-08-11T00:00:00.000Z",
  tokenId: ""
};

const previousRegistry: RemoteRegistrySnapshot = {
  existed: true,
  registry: {
    version: 1,
    active: "mini",
    remotes: [{ ...remote, tokenId: "old-token-id" }]
  }
};

function enrollmentJournal(
  phase: RemoteEnrollmentJournal["phase"] = "prepared"
): RemoteEnrollmentJournal {
  return {
    version: 1,
    kind: "enrollment",
    phase,
    transactionId: "transaction-1",
    recordedAt: "2026-08-11T00:00:00.000Z",
    name: "mini",
    issuedTokenId: "token-id",
    issuedToken: "private-token",
    previousRegistry,
    previousToken: "old-private-token",
    nextRegistry: {
      version: 1,
      active: "mini",
      remotes: [{ ...remote, tokenId: "token-id" }]
    }
  };
}

function removalJournal(phase: RemoteRemovalJournal["phase"] = "prepared"): RemoteRemovalJournal {
  return {
    version: 1,
    kind: "removal",
    phase,
    transactionId: "transaction-2",
    recordedAt: "2026-08-11T00:00:00.000Z",
    name: "mini",
    tokenId: "old-token-id",
    previousRegistry,
    previousToken: "old-private-token",
    nextRegistry: { version: 1, remotes: [] }
  };
}

function transactionPorts(
  overrides: Partial<RemoteEnrollmentTransactionPorts> = {}
): RemoteEnrollmentTransactionPorts {
  return {
    writeJournal: () => undefined,
    clearJournal: () => undefined,
    writeCredential: async () => undefined,
    commitRegistry: () => undefined,
    restoreRegistry: () => undefined,
    restoreCredential: async () => undefined,
    revoke: async () => undefined,
    recordCompensation: () => undefined,
    ...overrides
  };
}

test("remote enrollment writes durable phases around local mutations", async () => {
  const events: string[] = [];
  const transaction = new RemoteEnrollmentTransaction(
    { name: "mini", activate: true },
    transactionPorts({
      writeJournal: (journal) => events.push(`journal:${journal.phase}`),
      writeCredential: async () => {
        events.push("credential");
      },
      commitRegistry: () => events.push("registry"),
      clearJournal: () => events.push("clear")
    })
  );
  const staged = transaction.stage(
    remote,
    { id: "token-id", token: "private-token" },
    enrollmentJournal()
  );
  assert.deepEqual(await transaction.commit(), staged);
  assert.deepEqual(events, [
    "journal:prepared",
    "credential",
    "journal:credential-written",
    "registry",
    "journal:registry-committed",
    "clear"
  ]);
});

test("remote enrollment compensates each local commit-stage failure", async () => {
  for (const failure of ["journal", "credential", "credential-journal", "registry"] as const) {
    const events: string[] = [];
    let journalWrites = 0;
    const expected = new Error(`injected ${failure} failure`);
    const transaction = new RemoteEnrollmentTransaction(
      { name: "mini", activate: true },
      transactionPorts({
        writeJournal: () => {
          journalWrites += 1;
          events.push(`journal-${journalWrites}`);
          if (
            (failure === "journal" && journalWrites === 1) ||
            (failure === "credential-journal" && journalWrites === 2)
          ) {
            throw expected;
          }
        },
        writeCredential: async () => {
          events.push("credential");
          if (failure === "credential") throw expected;
        },
        commitRegistry: () => {
          events.push("registry");
          if (failure === "registry") throw expected;
        },
        revoke: async () => {
          events.push("revoke");
        }
      })
    );
    transaction.stage(remote, { id: "token-id", token: "private-token" }, enrollmentJournal());
    await assert.rejects(transaction.commit(), (error: unknown) => error === expected);
    assert.equal(events.at(-1), "revoke", failure);
  }
});

test("remote enrollment records failed remote compensation", async () => {
  const commitError = new Error("registry unavailable");
  const compensationError = new Error("remote revoke unavailable");
  const compensations: Array<{ remote: string; tokenId: string; reason: string }> = [];
  const transaction = new RemoteEnrollmentTransaction(
    { name: "mini", activate: true },
    transactionPorts({
      commitRegistry: () => {
        throw commitError;
      },
      revoke: async () => {
        throw compensationError;
      },
      recordCompensation: (name, tokenId, reason) => {
        compensations.push({ remote: name, tokenId, reason });
      }
    })
  );
  transaction.stage(remote, { id: "token-id", token: "private-token" });
  await assert.rejects(transaction.commit(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [commitError, compensationError]);
    return true;
  });
  assert.deepEqual(compensations, [
    { remote: "mini", tokenId: "token-id", reason: "remote revoke unavailable" }
  ]);
});

test("remote enrollment preserves every failure when compensation recording fails", async () => {
  const commitError = new Error("registry unavailable");
  const compensationError = new Error("remote revoke unavailable");
  const recordError = new Error("compensation journal unavailable");
  const transaction = new RemoteEnrollmentTransaction(
    { name: "mini", activate: true },
    transactionPorts({
      commitRegistry: () => {
        throw commitError;
      },
      revoke: async () => {
        throw compensationError;
      },
      recordCompensation: () => {
        throw recordError;
      }
    })
  );
  transaction.stage(remote, { id: "token-id", token: "private-token" });
  await assert.rejects(transaction.commit(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [commitError, compensationError, recordError]);
    assert.match(error.message, /unresolved compensation could not be recorded/);
    return true;
  });
});

test("remote enrollment rollback attempts registry and credential restoration", async () => {
  const originalError = new Error("enrollment failed");
  const registryError = new Error("registry restore failed");
  const credentialError = new Error("credential restore failed");
  const events: string[] = [];
  const transaction = new RemoteEnrollmentTransaction(
    { name: "mini", activate: true },
    transactionPorts({
      restoreRegistry: () => {
        events.push("registry");
        throw registryError;
      },
      restoreCredential: async () => {
        events.push("credential");
        throw credentialError;
      }
    })
  );
  await assert.rejects(transaction.rollback(originalError), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [originalError, registryError, credentialError]);
    return true;
  });
  assert.deepEqual(events, ["registry", "credential"]);
});

test("remote enrollment rejects invalid state transitions", async () => {
  const transaction = new RemoteEnrollmentTransaction(
    { name: "mini", activate: true },
    transactionPorts()
  );
  await assert.rejects(transaction.commit(), /has not been staged/);
  transaction.stage(remote, { id: "token-id", token: "private-token" });
  assert.throws(
    () => transaction.stage(remote, { id: "other-token", token: "other-private-token" }),
    /already staged/
  );
});

function removalPorts(
  events: string[],
  overrides: Partial<ConstructorParameters<typeof RemoteRemovalTransaction>[0]> = {}
): ConstructorParameters<typeof RemoteRemovalTransaction>[0] {
  return {
    journal: removalJournal(),
    writeJournal: (journal) => events.push(`journal:${journal.phase}`),
    clearJournal: () => events.push("clear"),
    commitRegistry: () => events.push("registry"),
    deleteCredential: async () => {
      events.push("credential");
    },
    revokeRemote: async () => {
      events.push("revoke");
    },
    restoreLocal: async () => {
      events.push("restore");
    },
    ...overrides
  };
}

test("remote removal durably orders registry, credential, and remote revocation", async () => {
  const events: string[] = [];
  await new RemoteRemovalTransaction(removalPorts(events)).commit();
  assert.deepEqual(events, [
    "journal:prepared",
    "registry",
    "journal:registry-removed",
    "credential",
    "journal:credential-deleted",
    "revoke",
    "clear"
  ]);
});

test("remote removal restores local state for each pre-revocation failure", async () => {
  for (const failure of ["journal", "registry", "registry-journal", "credential"] as const) {
    const events: string[] = [];
    let journalWrites = 0;
    const error = new Error(`injected ${failure} failure`);
    const ports = removalPorts(events, {
      writeJournal: () => {
        journalWrites += 1;
        events.push(`journal-${journalWrites}`);
        if (
          (failure === "journal" && journalWrites === 1) ||
          (failure === "registry-journal" && journalWrites === 2)
        ) {
          throw error;
        }
      },
      commitRegistry: () => {
        events.push("registry");
        if (failure === "registry") throw error;
      },
      deleteCredential: async () => {
        events.push("credential");
        if (failure === "credential") throw error;
      }
    });
    await assert.rejects(new RemoteRemovalTransaction(ports).commit(), (value) => value === error);
    if (failure === "journal") {
      assert.deepEqual(events, ["journal-1"]);
    } else {
      assert.equal(events.at(-1), "clear");
      assert.ok(events.includes("restore"));
    }
    assert.equal(events.includes("revoke"), false);
  }
});

test("remote removal restores local state when remote revocation fails", async () => {
  const events: string[] = [];
  const revokeError = new Error("remote revoke failed");
  await assert.rejects(
    new RemoteRemovalTransaction(
      removalPorts(events, {
        revokeRemote: async () => {
          events.push("revoke");
          throw revokeError;
        }
      })
    ).commit(),
    (error: unknown) => error === revokeError
  );
  assert.deepEqual(events.slice(-3), ["revoke", "restore", "clear"]);
});

test("remote removal preserves revoke and local restoration failures", async () => {
  const events: string[] = [];
  const revokeError = new Error("remote revoke failed");
  const restoreError = new Error("local restore failed");
  await assert.rejects(
    new RemoteRemovalTransaction(
      removalPorts(events, {
        revokeRemote: async () => {
          throw revokeError;
        },
        restoreLocal: async () => {
          throw restoreError;
        }
      })
    ).commit(),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [revokeError, restoreError]);
      return true;
    }
  );
});

function recoveryPorts(input: {
  journal: RemoteEnrollmentJournal | RemoteRemovalJournal;
  registry: RemoteRegistry;
  token?: string;
  revokeError?: Error;
  compensationError?: Error;
}): { ports: RemoteTransactionRecoveryPorts; events: string[] } {
  const events: string[] = [];
  let token = input.token;
  let registry = input.registry;
  return {
    events,
    ports: {
      readJournal: () => input.journal,
      currentRegistry: () => registry,
      restoreRegistry: (snapshot) => {
        events.push("restore-registry");
        registry = snapshot.registry;
      },
      readCredential: async () => token,
      writeCredential: async (_name, value) => {
        events.push("restore-credential");
        token = value;
      },
      deleteCredential: async () => {
        events.push("delete-credential");
        token = undefined;
      },
      clearJournal: () => events.push("clear"),
      revoke: async () => {
        events.push("revoke");
        if (input.revokeError !== undefined) throw input.revokeError;
      },
      recordCompensation: () => {
        events.push("compensation");
        if (input.compensationError !== undefined) throw input.compensationError;
      }
    }
  };
}

test("recovery rolls back interrupted enrollment phases and revokes the issued token", async () => {
  for (const phase of ["prepared", "credential-written"] as const) {
    const { ports, events } = recoveryPorts({
      journal: enrollmentJournal(phase),
      registry: previousRegistry.registry,
      token: phase === "prepared" ? "old-private-token" : "private-token"
    });
    assert.equal(await recoverRemoteTransaction(ports), "rolled-back");
    assert.deepEqual(events, ["restore-registry", "restore-credential", "revoke", "clear"]);
  }
});

test("recovery accepts a fully committed enrollment after journal-clear failure", async () => {
  const journal = enrollmentJournal("registry-committed");
  const { ports, events } = recoveryPorts({
    journal,
    registry: journal.nextRegistry,
    token: journal.issuedToken
  });
  assert.equal(await recoverRemoteTransaction(ports), "completed");
  assert.deepEqual(events, ["clear"]);
});

test("recovery records unresolved enrollment compensation after local restoration", async () => {
  const { ports, events } = recoveryPorts({
    journal: enrollmentJournal("credential-written"),
    registry: previousRegistry.registry,
    token: "private-token",
    revokeError: new Error("remote unavailable")
  });
  assert.equal(await recoverRemoteTransaction(ports), "rolled-back");
  assert.deepEqual(events, [
    "restore-registry",
    "restore-credential",
    "revoke",
    "compensation",
    "clear"
  ]);
});

test("recovery preserves revocation and compensation-recording failures", async () => {
  const revokeError = new Error("remote unavailable");
  const compensationError = new Error("compensation journal unavailable");
  const { ports, events } = recoveryPorts({
    journal: enrollmentJournal("credential-written"),
    registry: previousRegistry.registry,
    token: "private-token",
    revokeError,
    compensationError
  });
  await assert.rejects(recoverRemoteTransaction(ports), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [revokeError, compensationError]);
    return true;
  });
  assert.deepEqual(events, ["restore-registry", "restore-credential", "revoke", "compensation"]);
});

test("recovery completes an interrupted removal or restores it when revocation fails", async () => {
  const journal = removalJournal("credential-deleted");
  const completed = recoveryPorts({
    journal,
    registry: journal.nextRegistry,
    token: undefined
  });
  assert.equal(await recoverRemoteTransaction(completed.ports), "completed");
  assert.deepEqual(completed.events, ["revoke", "clear"]);

  const failed = recoveryPorts({
    journal,
    registry: journal.nextRegistry,
    token: undefined,
    revokeError: new Error("remote unavailable")
  });
  await assert.rejects(recoverRemoteTransaction(failed.ports), /remote unavailable/);
  assert.deepEqual(failed.events, ["revoke", "restore-registry", "restore-credential"]);
});
