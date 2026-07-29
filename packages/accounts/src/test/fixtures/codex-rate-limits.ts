/**
 * Sanitized from the current Codex usage endpoint and response headers.
 * The active-limit value names the metering policy; the actual window still
 * arrives in the default x-codex header family.
 */
export const CODEX_RATE_LIMIT_CONTRACT_FIXTURE = {
  usage: {
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 1,
        limit_window_seconds: 604_800,
        reset_at: 1_785_855_838
      }
    },
    credits: {
      has_credits: false,
      unlimited: false,
      balance: "0"
    }
  },
  headers: {
    "x-codex-active-limit": "premium",
    "x-codex-primary-used-percent": "1",
    "x-codex-primary-window-minutes": "10080",
    "x-codex-primary-reset-at": "1785855838",
    "x-codex-credits-has-credits": "False",
    "x-codex-credits-balance": "0"
  }
} as const;
