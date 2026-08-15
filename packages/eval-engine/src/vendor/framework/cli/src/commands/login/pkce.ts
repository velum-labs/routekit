import { Crypto, Effect, Encoding, Schema } from "effect";

import { OPENROUTER_AUTH_URL } from "../../../../contracts/internal/src/openrouter-auth.ts";

const ORI_KEY_LABEL = "ori";
const VERIFIER_BYTE_LENGTH = 32;
const SHA_256: Crypto.DigestAlgorithm = "SHA-256";

// RFC 7636 §4.1: a code verifier is 43-128 characters from the unreserved set.
const VERIFIER_MIN_LENGTH = 43;
const VERIFIER_MAX_LENGTH = 128;

export const CODE_CHALLENGE_METHOD_S256 = "S256";

export const CodeVerifier = Schema.String.check(
  Schema.isLengthBetween(VERIFIER_MIN_LENGTH, VERIFIER_MAX_LENGTH),
  Schema.isPattern(/^[A-Za-z0-9\-._~]+$/u)
).pipe(Schema.brand("CodeVerifier"));
export type CodeVerifier = typeof CodeVerifier.Type;

export interface AuthUrlInput {
  readonly callbackUrl: string;
  readonly codeChallenge: string;
}

/**
 * RFC 7636 code verifier: a high-entropy, URL-safe random string. 32 random
 * bytes base64url-encoded yields a 43-character verifier.
 */
export const generateCodeVerifier: Effect.Effect<
  CodeVerifier,
  never,
  Crypto.Crypto
> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto
    .randomBytes(VERIFIER_BYTE_LENGTH)
    .pipe(Effect.orDie);
  return CodeVerifier.make(Encoding.encodeBase64Url(bytes));
});

/** S256 challenge: base64url(SHA-256(code_verifier)). */
export const deriveCodeChallenge = Effect.fn("Pkce.deriveCodeChallenge")(
  function* (codeVerifier: CodeVerifier) {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest(SHA_256, new TextEncoder().encode(codeVerifier))
      .pipe(Effect.orDie);
    return Encoding.encodeBase64Url(digest);
  }
);

export const buildAuthUrl = ({
  callbackUrl,
  codeChallenge,
}: AuthUrlInput): string => {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", CODE_CHALLENGE_METHOD_S256);
  url.searchParams.set("key_label", ORI_KEY_LABEL);
  return url.toString();
};
