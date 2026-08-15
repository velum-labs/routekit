import { Schema } from "effect";

import type { FeatureLogger } from "./feature-logger.ts";

export const HOOK_CONTROLLER = Symbol.for("routekit-eval/hooks/controller");

export interface Hook<T> {
  readonly kind: "broadcast";
  readonly dispatch: (payload: T) => Promise<void>;
}

export interface PipelineHook<T> {
  readonly kind: "pipeline";
  readonly dispatch: (payload: T) => Promise<{
    payload: T;
    stopped: boolean;
  }>;
}

interface HookControllerCarrier<T> {
  readonly [HOOK_CONTROLLER]: HookController<T>;
}

export const HookFlavor = Schema.Literals(["broadcast", "pipeline"]);
export type HookFlavor = typeof HookFlavor.Type;

export interface HookHandlerRegistration<
  THandler = unknown,
  TContext = unknown,
> {
  readonly handler: THandler;
  readonly context: () => TContext;
}

interface HookDispatchContext {
  readonly logger: FeatureLogger;
  readonly stop?: (() => void) | undefined;
}

type HookDispatchHandler<T> = (
  payload: T,
  context: HookDispatchContext
) => Promise<T | undefined> | T | undefined;

const isHookDispatchContext = (value: unknown): value is HookDispatchContext =>
  typeof value === "object" &&
  value !== null &&
  "logger" in value &&
  typeof value.logger === "object" &&
  value.logger !== null &&
  "error" in value.logger &&
  typeof value.logger.error === "function";

const isHookDispatchHandler = <T>(
  value: unknown
): value is HookDispatchHandler<T> => typeof value === "function";

const invokeHandler = <T>(
  registration: HookHandlerRegistration,
  payload: T,
  context: HookDispatchContext
): Promise<T | undefined> => {
  if (!isHookDispatchHandler<T>(registration.handler)) {
    return Promise.reject(
      new Error("Hook registration handler is not a function")
    );
  }
  return Promise.resolve(registration.handler(payload, context));
};

const logHandlerFailure = (
  context: HookDispatchContext,
  hookName: string,
  error: unknown
): void => {
  context.logger.error(`Hook handler failed for "${hookName}"`, error);
};

const dispatchBroadcast = async <T>(
  controller: HookController<T>,
  payload: T
): Promise<void> => {
  await Promise.all(
    controller.handlers.map(async (registration) => {
      const context = registration.context();
      if (!isHookDispatchContext(context)) {
        return;
      }
      try {
        await invokeHandler(registration, payload, context);
      } catch (error) {
        logHandlerFailure(
          context,
          controller.hookName ?? `${controller.flavor} hook`,
          error
        );
      }
    })
  );
};

const dispatchPipeline = async <T>(
  controller: HookController<T>,
  payload: T
): Promise<{ payload: T; stopped: boolean }> => {
  let currentPayload = payload;
  const stopState = { stopped: false };
  const stop = (): void => {
    stopState.stopped = true;
  };
  for (const registration of controller.handlers.map((handler) => handler)) {
    const context = registration.context();
    if (!isHookDispatchContext(context)) {
      continue;
    }
    try {
      const result = await invokeHandler(registration, currentPayload, {
        ...context,
        stop,
      });
      if (result !== undefined) {
        currentPayload = result;
      }
    } catch (error) {
      logHandlerFailure(
        context,
        controller.hookName ?? `${controller.flavor} hook`,
        error
      );
    }
    if (stopState.stopped) {
      break;
    }
  }
  return {
    payload: currentPayload,
    stopped: stopState.stopped,
  };
};

export interface HookController<T> {
  readonly flavor: HookFlavor;
  enabled: boolean;
  readonly handlers: HookHandlerRegistration[];
  hookName?: string;
  readonly appendHandler: (registration: HookHandlerRegistration) => void;
  readonly enable: () => void;
  readonly reset: () => void;
  readonly setHookName: (hookName: string) => void;
  readonly dispatch: (
    payload: T
  ) => Promise<undefined | { payload: T; stopped: boolean }>;
}

const makeHookController = <T>(flavor: HookFlavor): HookController<T> => {
  const controller: HookController<T> = {
    appendHandler: (registration) => {
      controller.handlers.push(registration);
    },
    dispatch: async (payload) => {
      if (!controller.enabled) {
        const name = controller.hookName ?? `${flavor} hook`;
        throw new Error(
          `Cannot dispatch ${name} before the hook runtime enables it`
        );
      }

      if (flavor === "broadcast") {
        await dispatchBroadcast(controller, payload);
        return;
      }
      return await dispatchPipeline(controller, payload);
    },
    enable: () => {
      controller.enabled = true;
    },
    enabled: false,
    flavor,
    handlers: [],
    reset: () => {
      controller.handlers.length = 0;
      controller.enabled = false;
    },
    setHookName: (hookName) => {
      controller.hookName = hookName;
    },
  };
  return controller;
};

const attachController = <T, H extends object>(
  handle: H,
  controller: HookController<T>
): H & HookControllerCarrier<T> => {
  const attached = Object.assign(handle, {
    [HOOK_CONTROLLER]: controller,
  });
  Object.defineProperty(attached, HOOK_CONTROLLER, {
    configurable: false,
    enumerable: false,
    value: controller,
    writable: false,
  });
  return attached;
};

export const createHook = <T>(): Hook<T> & HookControllerCarrier<T> => {
  const controller = makeHookController<T>("broadcast");
  return attachController(
    {
      dispatch: (payload: T) =>
        controller.dispatch(payload).then((result) => {
          if (result !== undefined) {
            throw new Error("Broadcast hook dispatch returned a result");
          }
        }),
      kind: "broadcast" as const,
    },
    controller
  );
};

export const createPipelineHook = <T>(): PipelineHook<T> &
  HookControllerCarrier<T> => {
  const controller = makeHookController<T>("pipeline");
  return attachController(
    {
      dispatch: (payload: T) =>
        controller.dispatch(payload).then((result) => {
          if (result === undefined) {
            throw new Error("Pipeline hook dispatch returned no result");
          }
          return result;
        }),
      kind: "pipeline" as const,
    },
    controller
  );
};

export type HookPayload<H> =
  H extends Hook<infer T> ? T : H extends PipelineHook<infer T> ? T : never;

export type ApiHooks = Readonly<
  Record<string, Hook<never> | PipelineHook<never>>
>;
