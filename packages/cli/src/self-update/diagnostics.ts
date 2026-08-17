const SENSITIVE_KEY = /(?:auth|token|password|secret|credential|cookie|session)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;
const AUTH_ASSIGNMENT =
  /\b(?:_authToken|_auth|authToken|token|password|secret)\s*[:=]\s*[^\s,;]+/gi;

export function redactDiagnostic(value: string, env: NodeJS.ProcessEnv): string {
  let result = value
    .replace(BEARER, "Bearer [redacted]")
    .replace(URL_USERINFO, "$1[redacted]@")
    .replace(AUTH_ASSIGNMENT, (match) => `${match.split(/[:=]/, 1)[0]}=[redacted]`);
  for (const [key, secret] of Object.entries(env)) {
    if (!SENSITIVE_KEY.test(key) || secret === undefined || secret.length < 6) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

export function diagnosticTail(value: string, env: NodeJS.ProcessEnv, maxLines = 8): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines)
    .map((line) => redactDiagnostic(line, env));
}

export class SelfUpdateInspectionError extends Error {
  readonly code: string;
  readonly remediation?: readonly string[];
  readonly diagnostics: readonly string[];
  readonly hint?: string;

  constructor(options: {
    code: string;
    message: string;
    remediation?: readonly string[];
    diagnostics?: readonly string[];
    hint?: string;
  });
  constructor(message: string, remediation: readonly string[], diagnostics: readonly string[]);
  constructor(
    optionsOrMessage:
      | string
      | {
          code: string;
          message: string;
          remediation?: readonly string[];
          diagnostics?: readonly string[];
          hint?: string;
        },
    remediation: readonly string[] = [],
    diagnostics: readonly string[] = []
  ) {
    const options =
      typeof optionsOrMessage === "string"
        ? {
            code: "self_update_inspection_failed",
            message: optionsOrMessage,
            remediation,
            diagnostics
          }
        : optionsOrMessage;
    super(options.message);
    this.name = "SelfUpdateInspectionError";
    this.code = options.code;
    this.remediation = options.remediation;
    this.diagnostics = options.diagnostics ?? [];
    this.hint = options.hint;
  }
}
