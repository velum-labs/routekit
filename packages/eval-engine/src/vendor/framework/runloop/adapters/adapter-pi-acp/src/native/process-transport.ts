import { Effect, Option } from "effect";

import type { PiAdapterConfig } from "../config.ts";
import type { JsonlProcess } from "../../../../../engine/acp-adapter-kit/src/jsonl-process.ts";

import { PiCredentialError } from "../errors.ts";
import { OPENROUTER_API_KEY_MISSING_MESSAGE } from "../../../../../contracts/internal/src/openrouter-auth.ts";
import { RuntimeSecretStore } from "../../../../../contracts/internal/src/runtime/runtime-secret-store.ts";
import { RuntimeSecretName } from "../../../../../contracts/internal/src/runtime/services.ts";
import {
  makeJsonlProcess,
  MAX_JSONL_RECORD_LENGTH,
  STDIN_QUEUE_CAPACITY,
} from "../../../../../engine/acp-adapter-kit/src/jsonl-process.ts";

import type { PiDecodedLine } from "./protocol.ts";
import type { PiCommand } from "./schema.ts";

import { buildPiProcess } from "./process-config.ts";
import {
  decodePiLine,
  encodePiCommand,
  PiMalformedLine,
  PiProtocolError,
} from "./protocol.ts";

type PiIncoming = PiDecodedLine | PiMalformedLine;

const SPAN_PREFIX = "PiProcessTransport";

type PiProcessTransport = JsonlProcess<PiIncoming, PiCommand, PiProtocolError>;

const makePiProcessTransport = Effect.fn("PiProcessTransport.make")(function* (
  adapterConfig: PiAdapterConfig
) {
  const secrets = yield* RuntimeSecretStore;
  const secret = yield* secrets.get(RuntimeSecretName.OpenRouterApiKey).pipe(
    Effect.mapError(
      () =>
        new PiCredentialError({
          detail: "Could not read OpenRouter credential",
        })
    )
  );
  if (Option.isNone(secret)) {
    return yield* new PiCredentialError({
      detail: OPENROUTER_API_KEY_MISSING_MESSAGE,
    });
  }
  const config = buildPiProcess(adapterConfig, secret.value);
  return yield* makeJsonlProcess({
    args: config.args,
    command: config.command,
    cwd: config.cwd,
    decodeLine: decodePiLine,
    encodeCommand: encodePiCommand,
    env: config.env,
    onMalformedLine: (error) => new PiMalformedLine({ detail: error.detail }),
    onMalformedUtf8: () =>
      new PiProtocolError({ detail: "Malformed UTF-8 in Pi JSONL record" }),
    onOversizedRecord: () =>
      new PiProtocolError({ detail: "Pi JSONL record exceeds size limit" }),
    spanPrefix: SPAN_PREFIX,
  });
});

export {
  makePiProcessTransport,
  MAX_JSONL_RECORD_LENGTH,
  STDIN_QUEUE_CAPACITY,
};
export type { PiProcessTransport };
