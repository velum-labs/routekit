import assert from "node:assert/strict";
import test from "node:test";

import { CliError } from "@velum-labs/routekit-cli-core";

import {
  fetchLatestRouteKitVersion,
  type RegistryFetch,
  ROUTEKIT_LATEST_URL,
  resolveInstallVersion
} from "../install-version.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("exact install versions bypass the npm registry", async () => {
  let fetchCalls = 0;
  const target = await resolveInstallVersion("1.2.3-rc.1", {
    fetcher: (async () => {
      fetchCalls += 1;
      return response({ version: "9.9.9" });
    }) as RegistryFetch
  });
  assert.equal(target, "1.2.3-rc.1");
  assert.equal(fetchCalls, 0);
});

test("latest resolves to an exact version from npm registry metadata", async () => {
  let requestedUrl = "";
  const target = await resolveInstallVersion("latest", {
    fetcher: (async (url) => {
      requestedUrl = String(url);
      return response({ version: "2.3.4" });
    }) as RegistryFetch
  });
  assert.equal(requestedUrl, ROUTEKIT_LATEST_URL);
  assert.equal(target, "2.3.4");
});

test("latest resolution rejects non-success registry responses", async () => {
  await assert.rejects(
    fetchLatestRouteKitVersion({
      fetcher: (async () => response({ token: "secret-response-body" }, 503)) as RegistryFetch
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.match(error.message, /could not resolve .*@latest/);
      assert.deepEqual(error.details, ["the npm registry returned HTTP 503"]);
      assert.doesNotMatch(JSON.stringify(error), /secret-response-body/);
      return true;
    }
  );
});

test("latest resolution rejects network failures without exposing their messages", async () => {
  const secret = "registry-token-super-secret";
  await assert.rejects(
    fetchLatestRouteKitVersion({
      fetcher: (async () => {
        throw new Error(secret);
      }) as RegistryFetch
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.deepEqual(error.details, ["the npm registry request failed or timed out"]);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(secret));
      return true;
    }
  );
});

test("latest resolution applies the configured timeout", async () => {
  await assert.rejects(
    fetchLatestRouteKitVersion({
      timeoutMs: 1,
      fetcher: (async (_url, init) => {
        await new Promise((resolve, reject) => {
          const keepAlive = setTimeout(resolve, 1_000);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(keepAlive);
              reject(init.signal?.reason);
            },
            { once: true }
          );
        });
        return response({ version: "9.9.9" });
      }) as RegistryFetch
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.deepEqual(error.details, ["the npm registry request failed or timed out"]);
      return true;
    }
  );
});

for (const payload of [
  {},
  { version: "latest" },
  { version: "1.x" },
  { version: "01.2.3" },
  { version: "1.2.3-alpha..1" },
  { version: 123 }
]) {
  test(`latest resolution rejects malformed metadata ${JSON.stringify(payload)}`, async () => {
    await assert.rejects(
      fetchLatestRouteKitVersion({
        fetcher: (async () => response(payload)) as RegistryFetch
      }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.deepEqual(error.details, [
          "the npm registry metadata did not contain an exact RouteKit version"
        ]);
        return true;
      }
    );
  });
}

test("latest resolution rejects invalid JSON metadata", async () => {
  await assert.rejects(
    fetchLatestRouteKitVersion({
      fetcher: (async () => new Response("{", { status: 200 })) as RegistryFetch
    }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.deepEqual(error.details, ["the npm registry returned invalid JSON metadata"]);
      return true;
    }
  );
});
