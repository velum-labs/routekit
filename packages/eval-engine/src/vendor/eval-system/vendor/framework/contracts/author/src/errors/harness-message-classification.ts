/**
 * Prose classifiers for harness output, used only at the boundary where raw
 * harness text first enters ROUTEKIT_EVAL.
 *
 * These exist because no harness reports "the context overflowed" or "that
 * session is gone" as a typed signal yet. Everything ROUTEKIT_EVAL *can* read as a typed
 * fact — exit codes, timeout flags, JSON-RPC codes, result subtypes — must be
 * read as a typed fact instead; see `docs/engineering/error-standard.md`.
 * Nothing downstream of a boundary mapper may call these.
 *
 * Add new provider wording HERE, with a row in the test table, and nowhere
 * else. Alternations: Anthropic ("prompt is too long", "input length and
 * `max_tokens` exceed context limit"), OpenAI-style ("maximum context length",
 * "exceeds the context window"), and generic gateway phrasings ("too many
 * tokens", "exceeds the token limit").
 *
 * "context window" needs a verb of exceeding next to it. A bare mention is not
 * a failure — a model that writes "I'm running low on context window" is
 * chatting — so the qualifiers between the verb and the noun are enumerated
 * instead of skipped with a wildcard.
 */

const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|input length and `?max_tokens`? exceed|maximum context length|(?:exceeds?|exceeded|beyond|over|above|larger than|longer than) (?:the )?(?:model'?s? )?(?:maximum |max |total |available |allowed |remaining )?context (?:window|limit)|context (?:window|limit) (?:size |limit )?(?:exceeded|too small)|context length exceeded|too many tokens|exceeds? the (?:model'?s? )?token limit/iu;

const MISSING_SESSION_PATTERN =
  /no session found|session not found|unknown session|could not resume unknown session|--resume requires a valid session|does not match any session title/iu;

/**
 * An ACP peer forwards the gateway's HTTP status as the leading token of its
 * JSON-RPC error message (`401: {"message":"User not found.",…}`), so the status
 * is anchored rather than searched: an unanchored `401` matches a model id, a
 * token count, or a quoted body.
 */
const UPSTREAM_AUTH_STATUS_PATTERN = /^\s*(?:401|403)\b/u;

/**
 * Classify raw harness output as a context overflow.
 *
 * Pass only text the harness produced as an *error*. Passing an assistant
 * message will misfire: a model that writes "I'm running low on context
 * window" is not a failure, and classifying it as one triggers a forced
 * compaction of a session that was never near its limit.
 */
export const isContextOverflowMessage = (
  message: string | undefined
): boolean => message !== undefined && CONTEXT_OVERFLOW_PATTERN.test(message);

/** Classify raw harness output as a stale or unknown session reference. */
export const isMissingSessionMessage = (message: string | undefined): boolean =>
  message !== undefined && MISSING_SESSION_PATTERN.test(message);

/**
 * Classify raw harness output as the upstream rejecting the credential.
 *
 * Without this the generic remote arm answers a bad key with "check the
 * selected model and provider status", which sends a reader after the one thing
 * that is not wrong.
 */
export const isUpstreamAuthRejection = (message: string | undefined): boolean =>
  message !== undefined && UPSTREAM_AUTH_STATUS_PATTERN.test(message);
