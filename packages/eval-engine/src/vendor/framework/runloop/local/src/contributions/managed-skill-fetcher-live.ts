import { homedir } from "node:os";

import {
  Config,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { HttpClient } from "effect/unstable/http";

import type { ManagedSkillFetcherShape } from "./managed-skill-fetcher.ts";

import { isOkStatus } from "../../../../contracts/internal/src/http-client.ts";
import {
  ManagedSkillFetcher,
  ManagedSkillFetchError,
} from "./managed-skill-fetcher.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const DEFAULT_SKILLS_API_URL = "https://openrouter.ai/api/v1/skills";
const SKILLS_API_URL_ENV = "ORI_SKILLS_API_URL";
const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const BUNDLE_VERSION_PATTERN = /\/versions\/(\d+)\/bundle$/u;
const SHARED_CREDENTIAL_PATH_SEGMENTS = [
  [".ori", "credentials.json"],
  [".openrouter", "credentials.json"],
] as const;

const SkillMetadataResponseSchema = Schema.Struct({
  data: Schema.Struct({
    bundle_download_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
    id: Schema.String,
  }),
});
const decodeSkillMetadataResponse = Schema.decodeUnknownEffect(
  SkillMetadataResponseSchema
);

// Mirrors the credential file written by `ori login` (framework/cli
// login/credentials-resolve.ts); the runloop cannot import the CLI package, so
// the shape is decoded against the same schema here.
const SharedCredentialsSchema = Schema.Struct({
  createdAt: Schema.String,
  key: Schema.String,
  userId: Schema.NullOr(Schema.String),
});
// Excess properties are tolerated so a newer `ori login` adding fields does
// not lock the runloop out of the key.
const decodeSharedCredentialsJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SharedCredentialsSchema)
);

const readSharedCredentialKey = Effect.fn("ManagedSkill.readSharedCredential")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = homedir();
    let key: string | undefined;
    for (const segments of SHARED_CREDENTIAL_PATH_SEGMENTS) {
      const candidate = path.join(home, ...segments);
      const raw = yield* fs.readFileString(candidate).pipe(Effect.option);
      if (Option.isNone(raw)) {
        continue;
      }
      const decoded = yield* decodeSharedCredentialsJson(raw.value).pipe(
        Effect.option
      );
      if (Option.isSome(decoded) && decoded.value.key.trim() !== "") {
        ({ key } = decoded.value);
        break;
      }
    }
    return key;
  }
);

const readOptionalEnv = (name: string): Effect.Effect<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Effect.map(Option.filter((value) => value.trim() !== "")),
    Effect.orElseSucceed(() => Option.none<string>()),
    Effect.map(Option.getOrUndefined)
  );

const fetchManagedSkillUrl = Effect.fn("ManagedSkill.fetchUrl")(function* (
  client: HttpClient.HttpClient,
  url: string,
  apiKey: string
) {
  const response = yield* client
    .get(url, { headers: { Authorization: `Bearer ${apiKey}` } })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ManagedSkillFetchError({
            detail: `could not reach the managed skills API at ${url}: ${formatUnknownError(cause)}`,
          })
      )
    );
  // `HttpClientResponse` does not surface `statusText`, so the non-ok message
  // carries the numeric status only.
  if (!isOkStatus(response.status)) {
    return yield* new ManagedSkillFetchError({
      detail: `managed skills API returned ${response.status} for ${url}`,
    });
  }
  return response;
});

const requireOpenRouterApiKey = Effect.fn("ManagedSkill.requireApiKey")(
  function* () {
    const envKey = yield* readOptionalEnv(OPENROUTER_API_KEY_ENV);
    if (envKey !== undefined) {
      return envKey;
    }
    const storedKey = yield* readSharedCredentialKey();
    if (storedKey !== undefined) {
      return storedKey;
    }
    return yield* new ManagedSkillFetchError({
      detail: `no OpenRouter key found in ${OPENROUTER_API_KEY_ENV} or the shared credentials.json; run \`ori login\` or export the key to resolve managed skills`,
    });
  }
);

const fetchManagedSkillBundle = (
  client: HttpClient.HttpClient
): ManagedSkillFetcherShape["fetchBundle"] =>
  Effect.fn("ManagedSkill.fetchBundle")(function* (
    skillId: string,
    version: number
  ) {
    const apiKey = yield* requireOpenRouterApiKey();
    const baseUrl =
      (yield* readOptionalEnv(SKILLS_API_URL_ENV)) ?? DEFAULT_SKILLS_API_URL;
    const response = yield* fetchManagedSkillUrl(
      client,
      `${baseUrl}/${skillId}/versions/${version}/bundle`,
      apiKey
    );
    const bytes = yield* response.arrayBuffer.pipe(
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.mapError(
        (cause) =>
          new ManagedSkillFetchError({
            detail: `could not read the bundle for "${skillId}" version ${version}: ${formatUnknownError(cause)}`,
          })
      )
    );
    return bytes;
  });

const fetchLatestManagedSkillVersion = (
  client: HttpClient.HttpClient
): ManagedSkillFetcherShape["fetchLatestVersion"] =>
  Effect.fn("ManagedSkill.fetchLatestVersion")(function* (skillId: string) {
    const apiKey = yield* requireOpenRouterApiKey();
    const baseUrl =
      (yield* readOptionalEnv(SKILLS_API_URL_ENV)) ?? DEFAULT_SKILLS_API_URL;
    const response = yield* fetchManagedSkillUrl(
      client,
      `${baseUrl}/${skillId}`,
      apiKey
    );
    const json = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new ManagedSkillFetchError({
            detail: `could not read metadata for "${skillId}": ${formatUnknownError(cause)}`,
          })
      )
    );
    const metadata = yield* decodeSkillMetadataResponse(json).pipe(
      Effect.mapError(
        (cause) =>
          new ManagedSkillFetchError({
            detail: `managed skills API returned an unexpected metadata shape for "${skillId}": ${String(cause)}`,
          })
      )
    );
    const bundleUrl = metadata.data.bundle_download_url;
    const match =
      bundleUrl === undefined || bundleUrl === null
        ? null
        : BUNDLE_VERSION_PATTERN.exec(bundleUrl);
    if (match?.[1] === undefined) {
      return yield* new ManagedSkillFetchError({
        detail: `managed skill "${skillId}" has no published version bundle`,
      });
    }
    return Number.parseInt(match[1], 10);
  });

/**
 * Live {@link ManagedSkillFetcher}: the OpenRouter managed-skills HTTP client
 * (RFC 0002 skill.md), authenticating via `OPENROUTER_API_KEY` or the shared
 * `ori login` credentials. `HttpClient` is captured once here at layer build and
 * threaded into the fetch helpers as a plain parameter, so it rides this layer's
 * build-time requirement channel while the method channels stay `FileSystem |
 * Path` (the port shape). Each provide site wires a nested
 * `Layer.provide(fetchHttpClientLayer)` to discharge it. `Layer.effect` (not
 * `Layer.succeed`) so the client acquisition runs at build.
 *
 * Why this self-discharges at each site instead of surfacing `HttpClient` to a
 * single composition root the way `TelemetryLive` does: this layer is built in
 * three unrelated contexts (the built-in feature catalog, feature boot services,
 * and `ori pack`) with no shared root to discharge it once, so a self-contained
 * layer is portable to all three. `TelemetryLive` has one root (the CLI) whose
 * scope must outlive its exit-flush finalizer, so its transport has to come from
 * that longer-lived outer scope rather than a nested provide.
 */
export const ManagedSkillFetcherLive: Layer.Layer<
  ManagedSkillFetcher,
  never,
  HttpClient.HttpClient
> = Layer.effect(ManagedSkillFetcher)(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return ManagedSkillFetcher.of({
      fetchBundle: fetchManagedSkillBundle(client),
      fetchLatestVersion: fetchLatestManagedSkillVersion(client),
    });
  })
);
