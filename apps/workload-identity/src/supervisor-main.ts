#!/usr/bin/env node
import { runSupervisor } from "./supervisor.js";

const publicKey = process.env.ROUTEKIT_RUNTIME_MANIFEST_PUBLIC_KEY;
if (publicKey === undefined || publicKey.length === 0) {
  throw new Error("ROUTEKIT_RUNTIME_MANIFEST_PUBLIC_KEY is required");
}
await runSupervisor(publicKey);
