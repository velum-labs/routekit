import { Duration } from "effect";

const UPDATE_CHECK_CACHE_STALE_AFTER_DAYS = 7;

export const UPDATE_CHECK_CACHE_STALE_AFTER_MS = Duration.toMillis(
  Duration.days(UPDATE_CHECK_CACHE_STALE_AFTER_DAYS)
);

export const VERSION_UPDATE_CHECK_CACHE_STALE_AFTER_MS = Duration.toMillis(
  Duration.hours(1)
);

export const isUpdateCheckCacheFresh = (
  checkedAt: string | undefined,
  now: number,
  maxAgeMs: number
): boolean => {
  if (checkedAt === undefined) {
    return false;
  }
  const checkedAtMs = Date.parse(checkedAt);
  if (Number.isNaN(checkedAtMs)) {
    return false;
  }
  return now - checkedAtMs <= maxAgeMs;
};
