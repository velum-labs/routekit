import type {
  AgentRuntimeEvent,
  AgentSession,
  HarnessCompactionOptions,
  HarnessInvokeOptions,
} from "../../../contracts/author/src/index.ts";
import type { AgentHarness } from "../../../contracts/internal/src/author-schemas/agent-harness.ts";

export interface OpenedPublicHarness {
  readonly close?: (() => Promise<void>) | undefined;
  readonly compact?:
    | ((options: HarnessCompactionOptions) => AsyncIterable<AgentRuntimeEvent>)
    | undefined;
  readonly prompt?: (
    options: HarnessInvokeOptions
  ) => AsyncIterable<AgentRuntimeEvent>;
  readonly connect?:
    | ((options: HarnessInvokeOptions) => Promise<AgentSession>)
    | undefined;
  readonly probe?: (() => Promise<string | undefined>) | undefined;
}

type CallbackKey = "close" | "compact" | "prompt" | "connect" | "probe";
type CallbackMap = {
  [Key in CallbackKey]?: NonNullable<OpenedPublicHarness[Key]>;
};

const validateTurnRegistration = (
  contribution: AgentHarness,
  callbacks: CallbackMap
): void => {
  if (callbacks.prompt === undefined && callbacks.connect === undefined) {
    throw new Error(
      `Harness "${contribution.name}" did not register a turn callback`
    );
  }
  if (callbacks.prompt !== undefined && callbacks.connect !== undefined) {
    throw new Error(
      `Harness "${contribution.name}" registered both prompt and connect callbacks`
    );
  }
};

export const openPublicHarness = async (
  contribution: AgentHarness,
  setDefaultModel: (model: string | undefined) => void
): Promise<OpenedPublicHarness> => {
  const callbacks: CallbackMap = {};
  const register = <Key extends CallbackKey>(
    key: Key,
    callback: NonNullable<CallbackMap[Key]>
  ): void => {
    if (callbacks[key] !== undefined) {
      throw new Error(
        `Harness "${contribution.name}" registered ${key} more than once`
      );
    }
    callbacks[key] = callback;
  };
  try {
    await contribution.init({
      registerClose: (close) => {
        register("close", close);
      },
      registerCompaction: (compact) => {
        register("compact", compact);
      },
      registerPrompt: (prompt) => {
        register("prompt", prompt);
      },
      registerConnect: (connect) => {
        register("connect", connect);
      },
      registerProbe: (probe) => {
        register("probe", probe);
      },
      setDefaultModel,
    });
    validateTurnRegistration(contribution, callbacks);
  } catch (error) {
    await callbacks.close?.().catch((closeError: unknown) => {
      void closeError;
    });
    throw error;
  }
  return callbacks;
};

const dropRegistration = (): void => {
  // Registration metadata discovery keeps the callbacks unreachable on
  // purpose: nothing is opened, so nothing needs validating or closing.
};

/**
 * Reads the model registered through `setDefaultModel` without opening the
 * harness. Initialization is registration-only by contract, so running it
 * costs nothing beyond the callbacks it writes down, and those callbacks are
 * discarded here: no turn validation runs and no registered close is invoked
 * because no session or process ever existed.
 */
export const readRegisteredDefaultModel = async (
  contribution: AgentHarness
): Promise<string | undefined> => {
  let defaultModel: string | undefined;
  await contribution.init({
    registerClose: dropRegistration,
    registerCompaction: dropRegistration,
    registerConnect: dropRegistration,
    registerProbe: dropRegistration,
    registerPrompt: dropRegistration,
    setDefaultModel: (model) => {
      defaultModel = model;
    },
  });
  return defaultModel;
};
