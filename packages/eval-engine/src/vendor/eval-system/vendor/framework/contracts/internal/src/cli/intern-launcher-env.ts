import { Option, Schema } from "effect";

const ROUTEKIT_EVAL_INTERN_FEATURES_ROOT_ENV = "ROUTEKIT_EVAL_INTERN_FEATURES_ROOT";
const ROUTEKIT_EVAL_INTERN_LAUNCH_CWD_ENV = "ROUTEKIT_EVAL_INTERN_LAUNCH_CWD";
const ROUTEKIT_EVAL_INTERN_PACKED_ENV = "ROUTEKIT_EVAL_INTERN_PACKED";
const ROUTEKIT_EVAL_INTERN_WORKSPACE_ROOT_ENV = "ROUTEKIT_EVAL_INTERN_WORKSPACE_ROOT";
/**
 * Identifies the persona the daemon should load at boot.
 *
 * Kept distinct from {@link ROUTEKIT_EVAL_INTERN_PACKED_ENV} on purpose: packed-intern
 * mode also forces the bundling module-build policy, which is not correct for
 * persona-specific runtimes booting against a real on-disk workspace with
 * installed dependencies. Both signals do, however, disable the built-in
 * feature-development skill (see `disabledBuiltInSkillNamesForEnv`).
 */
const ROUTEKIT_EVAL_PERSONA_ENV = "ROUTEKIT_EVAL_PERSONA";

const PERSONA_VALUES = ["code", "eval"] as const;
const PersonaSchema = Schema.Literals(PERSONA_VALUES);
type Persona = typeof PersonaSchema.Type;

type LauncherEnv = Readonly<Record<string, string | undefined>>;

interface PackedInternLauncherEnv {
  readonly featuresRoot?: string | undefined;
  readonly launchCwd?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}

const isPackedInternEnv = (env: LauncherEnv): boolean =>
  env[ROUTEKIT_EVAL_INTERN_PACKED_ENV] === "1";

const readPersonaEnv = (env: LauncherEnv): Persona | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(PersonaSchema)(env[ROUTEKIT_EVAL_PERSONA_ENV])
  );

const nonEmptyEnvValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export const readPackedInternLauncherEnv = (
  env: LauncherEnv
): PackedInternLauncherEnv => {
  if (!isPackedInternEnv(env)) {
    return {};
  }
  const featuresRoot = nonEmptyEnvValue(env[ROUTEKIT_EVAL_INTERN_FEATURES_ROOT_ENV]);
  const launchCwd = nonEmptyEnvValue(env[ROUTEKIT_EVAL_INTERN_LAUNCH_CWD_ENV]);
  const workspaceRoot = nonEmptyEnvValue(env[ROUTEKIT_EVAL_INTERN_WORKSPACE_ROOT_ENV]);
  return {
    featuresRoot,
    launchCwd,
    workspaceRoot,
  };
};

export const readPackedInternLaunchCwd = (
  env: LauncherEnv
): string | undefined => readPackedInternLauncherEnv(env).launchCwd;

export {
  ROUTEKIT_EVAL_INTERN_FEATURES_ROOT_ENV,
  ROUTEKIT_EVAL_INTERN_LAUNCH_CWD_ENV,
  ROUTEKIT_EVAL_INTERN_PACKED_ENV,
  ROUTEKIT_EVAL_INTERN_WORKSPACE_ROOT_ENV,
  ROUTEKIT_EVAL_PERSONA_ENV,
  isPackedInternEnv,
  readPersonaEnv,
};
export type { PackedInternLauncherEnv, Persona };
