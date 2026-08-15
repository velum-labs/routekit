import { Effect } from "effect";

import type {
  AcpClientCorrelatedResult,
  AcpClientKnownRequest,
} from "../../../contracts/internal/src/acp/protocol/profile.ts";

type SessionPromptRequest = Extract<
  AcpClientKnownRequest,
  { readonly method: "session/prompt" }
>;
type SessionLoadRequest = Extract<
  AcpClientKnownRequest,
  { readonly method: "session/load" }
>;
type SessionResumeRequest = Extract<
  AcpClientKnownRequest,
  { readonly method: "session/resume" }
>;

export type SessionPromptContent = SessionPromptRequest["params"]["prompt"];
export type SessionPromptParams = SessionPromptRequest["params"];
export type SessionLoadParams = SessionLoadRequest["params"];
export type SessionResumeParams = SessionResumeRequest["params"];

/**
 * Both native-wire adapters advertise the same capability set — they drive the
 * same reference agent over the same protocol version and neither supports
 * audio, images, embedded context, or remote MCP — so only the agent's own name
 * varies.
 */
export const makeInitializeResult =
  (agentName: string): (() => Effect.Effect<AcpClientCorrelatedResult>) =>
  () =>
    Effect.succeed({
      method: "initialize" as const,
      result: {
        agentCapabilities: {
          auth: {},
          loadSession: true,
          mcpCapabilities: {
            http: false,
            sse: false,
          },
          promptCapabilities: {
            audio: false,
            embeddedContext: false,
            image: false,
          },
          sessionCapabilities: {
            resume: {},
          },
        },
        agentInfo: {
          name: agentName,
          version: "0.0.0",
        },
        authMethods: [],
        protocolVersion: 1 as const,
      },
    });
