import { createPrivateKey, createSign } from "node:crypto";

import { Clock, Effect, Encoding, Option, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { RepoRef } from "./remote-feature-source.ts";

import { HostProcess } from "../../../../contracts/internal/src/cli/host-process.ts";
import { CliFailureError } from "../../../../contracts/internal/src/errors.ts";
import {
  isOkStatus,
  readHttpResponseText,
} from "../../../../contracts/internal/src/http-client.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

/**
 * GitHub authentication for the remote-features fetch. A plain PAT
 * (`GITHUB_TOKEN`/`GH_TOKEN`) is used as-is when present. Otherwise, if the
 * `intern-worker` GitHub App credentials are in the environment, a short-lived
 * installation access token scoped to just the referenced repo is minted and
 * returned. When neither is set the fetch stays anonymous (public repos only).
 *
 * Minting follows GitHub's App flow: sign an RS256 JWT with the App private key,
 * look up the repo's installation, then exchange the JWT for a repo-scoped
 * installation token. Spec: RFC 0006.9.0 (token-acquisition order, secret-safe
 * error rule).
 */

/** Numeric App ID of the GitHub App; not secret on its own. */
const GH_APP_ID_ENV = "GH_APP_ID";
/** Base64-encoded PEM private key for the App; signs the JWT. The real secret. */
const GH_APP_PRIVATE_KEY_ENV = "GH_APP_PRIVATE_KEY";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_ACCEPT_JSON = "application/vnd.github+json";
const USER_AGENT = "ori";

// GitHub caps App JWT lifetime at 10 minutes and recommends back-dating `iat`
// by 60s to tolerate clock drift between us and their servers.
const JWT_CLOCK_SKEW_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const MILLIS_PER_SECOND = 1000;

const InstallationSchema = Schema.Struct({ id: Schema.Number });
const AccessTokenSchema = Schema.Struct({ token: Schema.String });

const decodeInstallation = Schema.decodeUnknownEffect(InstallationSchema);
const decodeAccessToken = Schema.decodeUnknownEffect(AccessTokenSchema);

// Every failure below carries only the App ID, owner/repo, and HTTP status —
// never the private key, the JWT, or the minted token.
const appAuthFailure = (detail: string): CliFailureError =>
  new CliFailureError({
    detail: `GitHub App authentication failed: ${detail}`,
  });

const encodeJson = (value: unknown): string =>
  Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));

const PEM_HEADER = "-----BEGIN";

// The App key is provisioned as base64-encoded PEM, but tolerate a value that
// is already a raw PEM so an un-encoded secret still works.
const decodePrivateKeyPem = (value: string): string =>
  value.trimStart().startsWith(PEM_HEADER)
    ? value
    : Buffer.from(value, "base64").toString("utf-8");

/**
 * Build an RS256-signed JWT for the App. Effect's `Crypto` service only offers
 * random bytes and digests, so RSA signing goes through `node:crypto`.
 */
const buildAppJwt = Effect.fn("GithubApp.buildJwt")(function* (input: {
  readonly appId: string;
  readonly privateKeyBase64: string;
}) {
  const nowSeconds = Math.floor(
    (yield* Clock.currentTimeMillis) / MILLIS_PER_SECOND
  );
  return yield* Effect.try({
    catch: () =>
      appAuthFailure(
        `${GH_APP_PRIVATE_KEY_ENV} is not a valid base64-encoded PEM private key`
      ),
    try: () => {
      const key = createPrivateKey(decodePrivateKeyPem(input.privateKeyBase64));
      const signingInput = `${encodeJson({
        alg: "RS256",
        typ: "JWT",
      })}.${encodeJson({
        exp: nowSeconds + JWT_LIFETIME_SECONDS,
        iat: nowSeconds - JWT_CLOCK_SKEW_SECONDS,
        iss: input.appId,
      })}`;
      const signature = createSign("RSA-SHA256").update(signingInput).sign(key);
      return `${signingInput}.${Encoding.encodeBase64Url(new Uint8Array(signature))}`;
    },
  });
});

const jwtHeaders = (jwt: string): Record<string, string> => ({
  accept: GITHUB_ACCEPT_JSON,
  authorization: `Bearer ${jwt}`,
  "user-agent": USER_AGENT,
  "x-github-api-version": GITHUB_API_VERSION,
});

const findInstallationId = Effect.fn("GithubApp.findInstallation")(function* (
  input: RepoRef & { readonly jwt: string }
) {
  const client = yield* HttpClient.HttpClient;
  const url = `${GITHUB_API_BASE}/repos/${input.owner}/${input.repo}/installation`;
  const response = yield* client
    .execute(HttpClientRequest.get(url, { headers: jwtHeaders(input.jwt) }))
    .pipe(
      Effect.mapError((cause) =>
        appAuthFailure(
          `could not reach GitHub to look up the installation for ${input.owner}/${input.repo} (${formatUnknownError(cause)})`
        )
      )
    );
  if (!isOkStatus(response.status)) {
    return yield* appAuthFailure(
      `GitHub returned ${response.status} looking up the App installation for ${input.owner}/${input.repo}. Confirm the App is installed on that repository.`
    );
  }
  const payload = yield* response.json.pipe(
    Effect.mapError(() =>
      appAuthFailure("could not read the installation lookup response")
    )
  );
  const decoded = yield* decodeInstallation(payload).pipe(
    Effect.mapError(() =>
      appAuthFailure(
        "the installation lookup response was not in the expected shape"
      )
    )
  );
  return decoded.id;
});

const mintInstallationToken = Effect.fn("GithubApp.mintToken")(function* (
  input: RepoRef & { readonly installationId: number; readonly jwt: string }
) {
  const client = yield* HttpClient.HttpClient;
  const url = `${GITHUB_API_BASE}/app/installations/${input.installationId}/access_tokens`;
  const response = yield* client
    .execute(
      HttpClientRequest.post(url, {
        // Least privilege: the token can only read the one repo we clone.
        body: HttpBody.jsonUnsafe({ repositories: [input.repo] }),
        headers: jwtHeaders(input.jwt),
      })
    )
    .pipe(
      Effect.mapError((cause) =>
        appAuthFailure(
          `could not reach GitHub to mint an installation token (${formatUnknownError(cause)})`
        )
      )
    );
  if (!isOkStatus(response.status)) {
    const body = yield* readHttpResponseText(response);
    const suffix = body.trim().length === 0 ? "" : ` Response: ${body.trim()}`;
    return yield* appAuthFailure(
      `GitHub returned ${response.status} minting an installation token for ${input.owner}/${input.repo}.${suffix}`
    );
  }
  const payload = yield* response.json.pipe(
    Effect.mapError(() =>
      appAuthFailure("could not read the installation token response")
    )
  );
  const decoded = yield* decodeAccessToken(payload).pipe(
    Effect.mapError(() =>
      appAuthFailure(
        "the installation token response was not in the expected shape"
      )
    )
  );
  return decoded.token;
});

const mintAppInstallationToken = Effect.fn("GithubApp.mint")(function* (
  input: RepoRef & { readonly appId: string; readonly privateKeyBase64: string }
) {
  const jwt = yield* buildAppJwt({
    appId: input.appId,
    privateKeyBase64: input.privateKeyBase64,
  });
  const installationId = yield* findInstallationId({
    jwt,
    owner: input.owner,
    repo: input.repo,
  });
  return yield* mintInstallationToken({
    installationId,
    jwt,
    owner: input.owner,
    repo: input.repo,
  });
});

/**
 * Resolve the GitHub token to authenticate the remote-features download for
 * `source`. Returns the token to send (as `authorization: token <value>`), or
 * `None` for an anonymous request. A plain PAT takes precedence over the App
 * credentials; when only the App credentials are set, minting a repo-scoped
 * installation token is mandatory and any failure aborts the fetch.
 */
const resolveGithubAuthToken = Effect.fn("GithubApp.resolveToken")(function* (
  source: RepoRef
) {
  const hostProcess = yield* HostProcess;
  const env = yield* hostProcess.env;

  const plainToken = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (plainToken !== undefined) {
    return Option.some(plainToken);
  }

  const appId = env[GH_APP_ID_ENV];
  const privateKeyBase64 = env[GH_APP_PRIVATE_KEY_ENV];
  if (appId === undefined || privateKeyBase64 === undefined) {
    return Option.none<string>();
  }

  const token = yield* mintAppInstallationToken({
    appId,
    owner: source.owner,
    privateKeyBase64,
    repo: source.repo,
  });
  return Option.some(token);
});

export { resolveGithubAuthToken };
