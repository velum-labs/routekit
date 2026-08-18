import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  controlSurface,
  isRouteKitControlMethod,
  ROUTEKIT_CONTROL_METHODS
} from "@velum-labs/routekit-control";

const CALL_PATTERN = /\.call\(\s*["']([a-z][a-zA-Z0-9]*\.[a-zA-Z]+)["']/g;

function productionJsFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "test") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...productionJsFiles(path));
    else if (entry.name.endsWith(".js")) out.push(path);
  }
  return out;
}

function cliControlCalls(): Set<string> {
  const distRoot = fileURLToPath(new URL("..", import.meta.url));
  const called = new Set<string>();
  for (const file of productionJsFiles(distRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(CALL_PATTERN)) {
      const method = match[1];
      if (method !== undefined && isRouteKitControlMethod(method)) called.add(method);
    }
  }
  return called;
}

test("every control method has a CLI caller or an explicit non-CLI surface", () => {
  const called = cliControlCalls();
  const missingCli = ROUTEKIT_CONTROL_METHODS.filter(
    (method) => controlSurface(method) !== "daemon" && !called.has(method)
  );
  const unexpectedCli = ROUTEKIT_CONTROL_METHODS.filter(
    (method) => controlSurface(method) === "daemon" && called.has(method)
  );
  assert.deepEqual(
    { missingCli, unexpectedCli },
    { missingCli: [], unexpectedCli: [] },
    'annotate daemon-only methods with surface: "daemon"; give every other method a production CLI caller'
  );
});
