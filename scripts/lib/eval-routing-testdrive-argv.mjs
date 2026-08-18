/**
 * pnpm preserves the option separator used after a script name. Effect CLI
 * interprets that separator as the end of its own options, so remove only the
 * wrapper-owned leading separator and preserve any later separator.
 */
export function normalizeEvalRoutingTestdriveArgv(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("eval-routing testdrive argv must be an array of strings");
  }
  return argv[0] === "--" ? argv.slice(1) : [...argv];
}
