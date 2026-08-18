import { Effect, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { AuthorizationCode } from "./callback-server.ts";
import type { CodeVerifier } from "./pkce.ts";

import {
  CliFailureError,
  makeCliFailureFromCause,
} from "../../../../contracts/internal/src/errors.ts";
import {
  isOkStatus,
  readHttpResponseText,
} from "../../../../contracts/internal/src/http-client.ts";
import { OPENROUTER_KEYS_EXCHANGE_URL } from "../../../../contracts/internal/src/openrouter-auth.ts";
import { CODE_CHALLENGE_METHOD_S256 } from "./pkce.ts";
import { formatUnknownError } from "../../../../utils/core/src/error-formatting.ts";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_METHOD_NOT_ALLOWED = 405;

interface ExchangeCodeInput {
  readonly code: AuthorizationCode;
  readonly codeVerifier: CodeVerifier;
}

const ExchangeCodeRequestSchema = Schema.Struct({
  code: Schema.String,
  code_challenge_method: Schema.Literal(CODE_CHALLENGE_METHOD_S256),
  code_verifier: Schema.String,
});

const encodeExchangeCodeRequest = HttpBody.jsonSchema(
  ExchangeCodeRequestSchema
);

const AuthKeyResponseSchema = Schema.Struct({
  key: Schema.String,
  userId: Schema.NullOr(Schema.String),
}).pipe(Schema.encodeKeys({ userId: "user_id" }));

type ExchangedKey = typeof AuthKeyResponseSchema.Type;

const decodeAuthKeyResponse = Schema.decodeUnknownEffect(AuthKeyResponseSchema);

const formatExchangeError = (status: number, body: string): string => {
  const suffix = body.trim().length === 0 ? "" : ` Response: ${body.trim()}`;
  if (status === HTTP_BAD_REQUEST) {
    return `OpenRouter rejected the key exchange (HTTP 400). The code challenge method did not match.${suffix}`;
  }
  if (status === HTTP_FORBIDDEN) {
    return `OpenRouter rejected the key exchange (HTTP 403). Make sure you are logged in to OpenRouter and authorized Ori.${suffix}`;
  }
  if (status === HTTP_METHOD_NOT_ALLOWED) {
    return `OpenRouter rejected the key exchange (HTTP 405). The request must use POST over HTTPS.${suffix}`;
  }
  return `OpenRouter key exchange failed with HTTP ${status}.${suffix}`;
};

export const exchangeCodeForKey = Effect.fn("Login.exchangeCodeForKey")(
  function* (input: ExchangeCodeInput) {
    const client = yield* HttpClient.HttpClient;
    const body = yield* encodeExchangeCodeRequest({
      code: input.code,
      code_challenge_method: CODE_CHALLENGE_METHOD_S256,
      code_verifier: input.codeVerifier,
    }).pipe(
      Effect.mapError(
        makeCliFailureFromCause(
          "Failed to encode the OpenRouter key exchange request"
        )
      )
    );
    const response = yield* client
      .execute(HttpClientRequest.post(OPENROUTER_KEYS_EXCHANGE_URL, { body }))
      .pipe(
        Effect.mapError(
          makeCliFailureFromCause(
            `Failed to reach ${OPENROUTER_KEYS_EXCHANGE_URL}`
          )
        )
      );

    if (!isOkStatus(response.status)) {
      const errorBody = yield* readHttpResponseText(response);
      return yield* new CliFailureError({
        detail: formatExchangeError(response.status, errorBody),
      });
    }

    const payload = yield* response.json.pipe(
      Effect.mapError(
        makeCliFailureFromCause(
          "Failed to read the OpenRouter key exchange response"
        )
      )
    );

    const decoded = yield* decodeAuthKeyResponse(payload).pipe(
      Effect.mapError(
        (cause) =>
          new CliFailureError({
            detail: `Unexpected OpenRouter key exchange response: ${formatUnknownError(cause)}`,
          })
      )
    );

    return decoded;
  }
);

export type { ExchangeCodeInput, ExchangedKey };
