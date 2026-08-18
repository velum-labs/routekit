const safeStringifyError = (value: object): string | undefined => {
  try {
    // `JSON.stringify` is typed to return `string`, but at runtime yields
    // `undefined` for values whose serialization is absent (e.g. a `toJSON`
    // returning `undefined`), so the `undefined` guard below is load-bearing.
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined || json === "{}" ? undefined : json;
  } catch {
    return undefined;
  }
};

const formatObjectError = (error: object): string | undefined => {
  const { message } = error as { readonly message?: unknown };
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  return safeStringifyError(error);
};

/**
 * Render any thrown value as a single human-readable string. Unlike a bare
 * `String(error)`, this keeps non-`Error` causes (Effect defects, schema parse
 * failures, plain objects) from collapsing into `[object Object]`: it prefers a
 * non-empty `message`, then compact JSON, and only falls back to `String` for
 * values that resist both.
 *
 * Lives at the utils tier — the one layer every package (including builtins,
 * which may not import internal contracts) can reach — so call sites never
 * need a local `instanceof Error ? .message : String(x)` subset, which is
 * exactly the lossy copy this helper exists to prevent.
 */
export const formatUnknownError = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message.length > 0 ? error.message : error.name;
  }
  if (error !== null && typeof error === "object") {
    const rendered = formatObjectError(error);
    if (rendered !== undefined) {
      return rendered;
    }
  }
  return String(error);
};

const MAX_SAFE_ERROR_DIAGNOSTIC_LENGTH = 512;

const USER_PATH_PATTERN =
  /(?:\/Users\/|\/home\/)[^/\s]+(?:\/[^\s]*)?|C:\\Users\\[^\\/\s]+(?:\\[^\s]*)?/giu;

/** `https://user:password@host` — stripped before the query, which is a separate rule. */
const URL_USERINFO_PATTERN = /\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu;

const URL_PATTERN = /\bhttps?:\/\/[^\s]+/giu;

/**
 * An opaque path segment long enough to be a signed path or webhook token.
 *
 * Applied only inside a matched URL, so ordinary prose keeps its words. The
 * length floor is what separates a credential from the route names worth
 * keeping in a diagnostic (`/v1/chat/completions`).
 */
const URL_PATH_SECRET_PATTERN = /\/[A-Za-z0-9_-]{24,}(?=\/|$)/gu;

const OPENROUTER_KEY_PATTERN = /\bsk-(?:or-)?[A-Za-z0-9_-]+\b/gu;

/**
 * Vendor key formats that announce themselves with a fixed prefix. ORI does
 * not issue these, but its harnesses shell out to tools that do, and their
 * stderr is the text this redacts.
 */
const VENDOR_KEY_PATTERN =
  /\b(?:AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|(?:npm|dop_v1|shpat)_[A-Za-z0-9]{16,})\b/gu;

/**
 * `Authorization: Bearer …`, and the Basic/Token schemes that share its shape.
 *
 * The value must carry a digit or a separator, because these three scheme names
 * are also ordinary prose and an English word never does. Matching "Token" plus
 * any following word turns "Token limit exceeded" into "Token <secret>
 * exceeded" and mangles the very explanation this log exists to preserve.
 */
const AUTH_SCHEME_PATTERN =
  /\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9._~+/=-]{6,})(?=[A-Za-z0-9]*[\d._~+/=-])[A-Za-z0-9._~+/=-]+/giu;

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gu;

/**
 * Credential-bearing key names in `key=value` and `"key": "value"` text.
 *
 * `authorization` is absent on purpose: {@link AUTH_SCHEME_PATTERN} already
 * redacted its value, and matching the header name again would replace the
 * scheme word too, leaving a diagnostic that no longer says how the caller
 * authenticated.
 */
const SECRET_ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?key|session[_-]?token|client[_-]?secret|private[_-]?key|secret|password|passwd|credential|signature)("?\s*[=:]\s*)"?[^\s",}]+"?/giu;

/**
 * Key names that also name ordinary counters and settings, so a bare number is
 * left alone: `token=4096` is a budget, `token=a1b2c3…` is a credential.
 */
const AMBIGUOUS_ASSIGNMENT_PATTERN =
  /\b(token|auth|key)("?\s*[=:]\s*)"?(?!\d+\b)[^\s",}]+"?/giu;

/**
 * Render a bounded log diagnostic with common secrets and user paths removed.
 *
 * This is a safety net over text ORI did not author, not a guarantee: it
 * recognizes the credential shapes seen in provider, gateway, and process
 * output. Never rely on it to make an unbounded upstream payload safe — the
 * boundary is still required to classify and drop that payload instead.
 */
export const formatSafeErrorDiagnostic = (error: unknown): string =>
  formatUnknownError(error)
    .replaceAll(USER_PATH_PATTERN, "<user-path>")
    .replaceAll(URL_USERINFO_PATTERN, "$1<secret>@")
    .replaceAll(URL_PATTERN, (url) =>
      url
        .replace(/[?&#].*$/u, "")
        .replaceAll(URL_PATH_SECRET_PATTERN, "/<secret>")
    )
    .replaceAll(OPENROUTER_KEY_PATTERN, "<secret>")
    .replaceAll(VENDOR_KEY_PATTERN, "<secret>")
    .replaceAll(AUTH_SCHEME_PATTERN, "$1 <secret>")
    .replaceAll(JWT_PATTERN, "<secret>")
    .replaceAll(SECRET_ASSIGNMENT_PATTERN, "$1$2<secret>")
    .replaceAll(AMBIGUOUS_ASSIGNMENT_PATTERN, "$1$2<secret>")
    .slice(0, MAX_SAFE_ERROR_DIAGNOSTIC_LENGTH);

/**
 * The stack trace of a thrown value when it is an `Error` carrying one, else
 * `undefined`. A companion to {@link formatUnknownError} (which keeps only the
 * message): a diagnostic call site that wants the trace passes this as a
 * structured field rather than repeating the `instanceof Error && .stack`
 * narrowing inline. Lives at the same utils tier so every package can reach it.
 */
export const errorStack = (error: unknown): string | undefined =>
  error instanceof Error ? error.stack : undefined;
