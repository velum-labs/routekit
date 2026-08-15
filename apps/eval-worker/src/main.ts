import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import {
  EVAL_CONTRACT_VERSION,
  EvalWorkerRequest,
  type EvalWorkerResponse
} from "@velum-labs/routekit-eval-contracts";
import { runEvalSuite } from "@velum-labs/routekit-eval-core";
import { makeEvalStore } from "@velum-labs/routekit-eval-store";
import { runRouteKitEffect } from "@velum-labs/routekit-runtime/effect";
import { Effect, Schema } from "effect";

function write(response: EvalWorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export async function handleEvalWorkerLine(
  line: string,
  storeRoot = process.env.ROUTEKIT_EVAL_STORE
): Promise<EvalWorkerResponse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {
      version: EVAL_CONTRACT_VERSION,
      type: "error",
      id: "unknown",
      error: "unsupported eval worker request"
    };
  }
  const request = Schema.decodeUnknownExit(EvalWorkerRequest)(parsed);
  if (request._tag === "Failure") {
    const id =
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof parsed.id === "string"
        ? parsed.id
        : "unknown";
    return {
      version: EVAL_CONTRACT_VERSION,
      type: "error",
      id,
      error: "unsupported eval worker request"
    };
  }
  try {
    const result = await runRouteKitEffect(
      Effect.gen(function* () {
        const result = yield* runEvalSuite(request.value.spec, {
          gatewayUrl: request.value.gatewayUrl,
          token: request.value.token
        });
        if (storeRoot !== undefined && storeRoot.length > 0) {
          yield* makeEvalStore(storeRoot).writeRawRun(result);
        }
        return result;
      })
    );
    return { version: EVAL_CONTRACT_VERSION, type: "result", id: request.value.id, result };
  } catch (cause) {
    return {
      version: EVAL_CONTRACT_VERSION,
      type: "error",
      id: request.value.id,
      error: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

export async function runEvalWorker(
  input: NodeJS.ReadableStream = process.stdin,
  handle = handleEvalWorkerLine
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    write(await handle(line));
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  void runEvalWorker();
}
