import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";

import {
  EVAL_CONTRACT_VERSION,
  type EvalWorkerRequest,
  type EvalWorkerResponse
} from "@velum-labs/routekit-eval-contracts";
import { runEvalSuite } from "@velum-labs/routekit-eval-core/effect";
import { createEvalStore } from "@velum-labs/routekit-eval-store";
import { Effect } from "effect";

function write(response: EvalWorkerResponse): void {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

export async function handleEvalWorkerLine(
  line: string,
  storeRoot = process.env.ROUTEKIT_EVAL_STORE
): Promise<EvalWorkerResponse> {
  const parsed = JSON.parse(line) as EvalWorkerRequest;
  if (parsed.version !== EVAL_CONTRACT_VERSION || parsed.type !== "run") {
    return {
      version: EVAL_CONTRACT_VERSION,
      type: "error",
      id: typeof parsed.id === "string" ? parsed.id : "unknown",
      error: "unsupported eval worker request"
    };
  }
  try {
    const result = await Effect.runPromise(
      runEvalSuite(parsed.spec, { gatewayUrl: parsed.gatewayUrl, token: parsed.token })
    );
    if (storeRoot !== undefined && storeRoot.length > 0) {
      createEvalStore(storeRoot).writeRawRun(result);
    }
    return { version: EVAL_CONTRACT_VERSION, type: "result", id: parsed.id, result };
  } catch (cause) {
    return {
      version: EVAL_CONTRACT_VERSION,
      type: "error",
      id: parsed.id,
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
