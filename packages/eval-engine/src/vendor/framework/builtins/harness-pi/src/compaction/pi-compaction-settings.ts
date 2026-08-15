import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Option } from "effect";
import { normalizeEnvValue } from "../../../ori/src/process.ts";

import type { JsonObject } from "../openrouter-attribution/openrouter-attribution.ts";

import {
  decodeJsonObjectString,
  PI_CODING_AGENT_DIR_ENV,
  projectJsonObject,
} from "../openrouter-attribution/openrouter-attribution.ts";

const EMPTY_LENGTH = 0;
const JSON_INDENT = 2;
const FILE_NOT_FOUND_CODE = "ENOENT";
const PI_SETTINGS_FILE = "settings.json";
const PI_COMPACTION_FIELD = "compaction";
const PI_RESERVE_TOKENS_FIELD = "reserveTokens";
const PI_KEEP_RECENT_TOKENS_FIELD = "keepRecentTokens";
// Marks a `compaction` block as ori-derived so a later invoke may re-derive it
// for a different model. A block without the marker is user-authored and is
// never touched.
const ORI_DERIVED_FIELD = "oriDerived";

// Pi's compiled-in defaults, tuned for ~200k Anthropic windows. They are the
// ceiling of the derived policy: a large window keeps pi's stock behavior, a
// small window scales both budgets down so compaction fires before the
// provider rejects the prompt (ORI-300/ORI-408).
const PI_DEFAULT_RESERVE_TOKENS = 16_384;
const PI_DEFAULT_KEEP_RECENT_TOKENS = 20_000;
const MIN_RESERVE_TOKENS = 1024;
const RESERVE_WINDOW_FRACTION = 0.2;
const KEEP_RECENT_WINDOW_FRACTION = 0.25;

interface PiCompactionSizing {
  readonly keepRecentTokens: number;
  readonly reserveTokens: number;
}

/**
 * Derive pi's compaction budgets from the active model's context window.
 * Returns `undefined` for an unusable window (unknown, non-finite, or too
 * small to fit the minimum reserve plus the kept tail), leaving pi's own
 * defaults in place.
 */
export const derivePiCompactionSizing = (
  contextWindow?: number
): PiCompactionSizing | undefined => {
  if (contextWindow === undefined || !Number.isFinite(contextWindow)) {
    return undefined;
  }
  const sizing: PiCompactionSizing = {
    keepRecentTokens: Math.min(
      PI_DEFAULT_KEEP_RECENT_TOKENS,
      Math.floor(contextWindow * KEEP_RECENT_WINDOW_FRACTION)
    ),
    reserveTokens: Math.min(
      PI_DEFAULT_RESERVE_TOKENS,
      Math.max(
        MIN_RESERVE_TOKENS,
        Math.floor(contextWindow * RESERVE_WINDOW_FRACTION)
      )
    ),
  };
  // The MIN_RESERVE_TOKENS clamp can push the combined budgets past a tiny
  // window (e.g. 1025 → reserve 1024 + keep 256), so reject any sizing whose
  // sum does not leave room in the window.
  if (sizing.reserveTokens + sizing.keepRecentTokens >= contextWindow) {
    return undefined;
  }
  return sizing;
};

/**
 * Merge the derived compaction budgets into pi's `settings.json` content.
 * Returns the serialized file when a write is needed, `undefined` when nothing
 * changed, the existing content is undecodable (never clobber), or the
 * existing `compaction` block is user-authored (no {@link ORI_DERIVED_FIELD}
 * marker). Other settings keys — including `compaction.enabled` — pass
 * through untouched.
 */
const decodeExistingSettings = (
  existingContent: string | undefined
): Option.Option<JsonObject> => {
  const normalized = existingContent?.trim();
  return normalized === undefined || normalized.length === EMPTY_LENGTH
    ? Option.some<JsonObject>({})
    : decodeJsonObjectString(normalized);
};

// A block is skippable when it is user-authored (no ORI_DERIVED_FIELD marker
// on a pre-existing block) or already carries the sizing being derived —
// never clobber the former, no-op on the latter.
const compactionBlockNeedsUpdate = (
  config: Record<string, unknown>,
  sizing: PiCompactionSizing
): boolean => {
  const hasCompactionBlock = config[PI_COMPACTION_FIELD] !== undefined;
  const compaction = projectJsonObject(config[PI_COMPACTION_FIELD]);
  if (hasCompactionBlock && compaction[ORI_DERIVED_FIELD] !== true) {
    return false;
  }
  return (
    compaction[PI_RESERVE_TOKENS_FIELD] !== sizing.reserveTokens ||
    compaction[PI_KEEP_RECENT_TOKENS_FIELD] !== sizing.keepRecentTokens
  );
};

export const mergePiCompactionSettings = (
  existingContent: string | undefined,
  sizing: PiCompactionSizing
): string | undefined => {
  const decoded = decodeExistingSettings(existingContent);
  if (Option.isNone(decoded)) {
    return undefined;
  }

  const config: Record<string, unknown> = { ...decoded.value };
  if (!compactionBlockNeedsUpdate(config, sizing)) {
    return undefined;
  }

  const compaction = projectJsonObject(config[PI_COMPACTION_FIELD]);
  compaction[PI_RESERVE_TOKENS_FIELD] = sizing.reserveTokens;
  compaction[PI_KEEP_RECENT_TOKENS_FIELD] = sizing.keepRecentTokens;
  compaction[ORI_DERIVED_FIELD] = true;
  config[PI_COMPACTION_FIELD] = compaction;
  return `${JSON.stringify(config, null, JSON_INDENT)}\n`;
};

const readSettingsFile = async (
  settingsPath: string
): Promise<string | undefined> => {
  try {
    return await readFile(settingsPath, "utf-8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === FILE_NOT_FOUND_CODE
    ) {
      return undefined;
    }
    throw error;
  }
};

// Best-effort like ensurePiOpenRouterAttribution: never block a run on a
// config write failure. settings.json is global per agent dir, so concurrent
// invokes with different models race last-writer-wins; pi re-reads settings on
// every spawn, which bounds the damage to a single spawn.
export const ensurePiCompactionSettings = async (
  env: NodeJS.ProcessEnv,
  contextWindow: number | undefined
): Promise<void> => {
  const dir = normalizeEnvValue(env[PI_CODING_AGENT_DIR_ENV]);
  const sizing = derivePiCompactionSizing(contextWindow);
  if (dir === undefined || sizing === undefined) {
    return;
  }

  const settingsPath = join(dir, PI_SETTINGS_FILE);
  try {
    const existingContent = await readSettingsFile(settingsPath);
    const merged = mergePiCompactionSettings(existingContent, sizing);
    if (merged !== undefined) {
      await mkdir(dir, { recursive: true });
      await writeFile(settingsPath, merged, "utf-8");
    }
  } catch {
    // Config write is non-critical; leave any existing settings untouched on failure.
  }
};
