# @velum-labs/routekit-runtime/environment

> Intentional public surface snapshot. This is a review guard, not a stability promise.

Declaration SHA-256: `95501da9cc28aeed54a51005dc18f41b442fc655a24c82eb3d1009f3f95bd092`

## Root declarations

```ts
export declare const DEFAULT_BRIDGE_SCRUB_PREFIXES: readonly ["BRIDGE_", "MODEL_", "CURSOR_UPSTREAM"];
export declare const SERVICE_UNSET_ENV = "VELUM_SERVICE_UNSET_ENV";
export declare function buildChildEnv(input?: BuildChildEnvInput): Record<string, string>;
export declare function commandOnPath(command: string, env?: Record<string, string | undefined>): boolean;
export declare function definedEnv(env: EnvInput): Record<string, string>;
export declare function sanitizeServiceEnvironment(env?: Record<string, string | undefined>): void;
export declare function scrubBridgeEnv(env: EnvInput, prefixes?: readonly string[]): Record<string, string>;
export type BuildChildEnvInput = {
export {};
```
