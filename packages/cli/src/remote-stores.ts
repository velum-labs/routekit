import { RemoteCompensationRepository } from "./remote-compensation-repository.js";
import {
  type RemoteCredentialOptions,
  RemoteCredentialRepository
} from "./remote-credential-repository.js";
import { RemoteRegistryRepository } from "./remote-registry-repository.js";
import { RemoteTransactionJournalRepository } from "./remote-transaction-journal-repository.js";

export type RemoteStores = {
  registry: RemoteRegistryRepository;
  credentials: RemoteCredentialRepository;
  journal: RemoteTransactionJournalRepository;
  compensations: RemoteCompensationRepository;
};

export function createRemoteStores(credentialOptions: RemoteCredentialOptions = {}): RemoteStores {
  return {
    registry: new RemoteRegistryRepository(),
    credentials: new RemoteCredentialRepository(credentialOptions),
    journal: new RemoteTransactionJournalRepository(),
    compensations: new RemoteCompensationRepository()
  };
}
