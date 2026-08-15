import type { ApiFeatureContext } from "./api.ts";
import type { FeatureLogger } from "./feature-logger.ts";
import type { Hook, PipelineHook } from "./hooks-handles.ts";
import type { McpResolver } from "./mcp.ts";
import type {
  AgentRun,
  ScheduleInvokeInput,
} from "./schedule.ts";
import type { StoreResolver } from "./stores.ts";

export interface HookHandlerContext {
  readonly featureId: string;
  readonly logger: FeatureLogger;
  readonly use: ApiFeatureContext["use"];
  readonly invoke: <A = unknown>(input: ScheduleInvokeInput<A>) => AgentRun<A>;
  /**
   * Reach an MCP server declared in the workspace `mcp.json`. Optional: present
   * only when the host wired MCP for this run, so a handler guards before use.
   */
  readonly mcp?: McpResolver | undefined;
  readonly stores?: StoreResolver | undefined;
  readonly stop?: () => void;
}

export type BroadcastHookHandler<T> = (
  payload: T,
  context: HookHandlerContext
) => Promise<void> | void;

export type PipelineHookHandler<T> = (
  payload: T,
  context: HookHandlerContext
) => Promise<T | undefined> | T | undefined;

declare const featureHooksBrand: unique symbol;
export interface FeatureHooks {
  readonly [featureHooksBrand]?: never;
}

export type HooksContribution = {
  readonly [K in keyof FeatureHooks]?: FeatureHooks[K] extends Hook<infer T>
    ? BroadcastHookHandler<T>
    : FeatureHooks[K] extends PipelineHook<infer T>
      ? PipelineHookHandler<T>
      : never;
};

export type {
  ApiHooks,
  Hook,
  HookController,
  HookFlavor,
  HookPayload,
  PipelineHook,
} from "./hooks-handles.ts";
export {
  HOOK_CONTROLLER,
  createHook,
  createPipelineHook,
} from "./hooks-handles.ts";
