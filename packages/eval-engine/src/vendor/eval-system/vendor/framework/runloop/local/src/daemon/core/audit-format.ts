import type { Brand, Stream } from "effect";

import type { RouteKitEvalDaemonShape } from "./service.ts";

import { RUNTIME_AUDIT_LINE_PREFIX } from "../../../../../contracts/internal/src/runtime/audit-event.ts";

type RuntimeCommand = Parameters<RouteKitEvalDaemonShape["invoke"]>[0];
type RuntimeStreamEvent =
  ReturnType<RouteKitEvalDaemonShape["invoke"]> extends Stream.Stream<
    infer Event,
    unknown
  >
    ? Event
    : never;

type RuntimeAuditStreamEvent = Extract<
  RuntimeStreamEvent,
  { readonly type: "audit.event" }
>;

export const summarizeCommand = (
  command: RuntimeCommand,
  cwd: string
): {
  cwd: string;
  harnessName: (string & Brand.Brand<"HarnessName">) | undefined;
  model: string | null | undefined;
  promptLength: number;
  sessionId: (string & Brand.Brand<"SessionId">) | undefined;
  type: "agent.invoke";
} => ({
  cwd,
  harnessName: command.harnessName,
  model: command.model,
  promptLength: command.prompt.length,
  sessionId: command.sessionId,
  type: command.type,
});

export const formatRuntimeAuditEvent = (
  event: RuntimeAuditStreamEvent["audit"]
): string => {
  const prefix = `${RUNTIME_AUDIT_LINE_PREFIX} ${event.createdAt} ${event.level.toUpperCase()} ${event.name}`;
  const command = event.commandId ? ` command=${event.commandId}` : "";
  const detail =
    event.detail === undefined ? "" : ` detail=${JSON.stringify(event.detail)}`;
  return `${prefix}${command} ${event.message}${detail}`;
};

export const makeAuditStreamEvent = (
  audit: RuntimeAuditStreamEvent["audit"]
): RuntimeStreamEvent => ({
  audit,
  type: "audit.event",
});
