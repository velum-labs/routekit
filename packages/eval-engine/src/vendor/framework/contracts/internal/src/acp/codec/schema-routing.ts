import { Effect, Schema } from "effect";

import type { AcpSchemaDecodeError } from "../errors.ts";
import type { AcpPeer } from "../protocol/profile.ts";

import {
  AcpPeer as AcpPeerValue,
  AcpRequestDirection,
} from "../protocol/message-kinds.ts";
import {
  AGENT_REQUEST_SCHEMAS,
  AGENT_RESULT_SCHEMAS,
  AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS,
  CLIENT_REQUEST_SCHEMAS,
  CLIENT_RESULT_SCHEMAS,
  CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS,
} from "../protocol/profile.ts";

import type { AcpPendingRequest } from "./model.ts";

import { schemaFailure } from "./envelope.ts";

type SchemaMap = Readonly<Record<string, Schema.Constraint>>;

const absurd = (value: never): never => value;
const lookupSchema = (
  schemas: SchemaMap,
  method: string
): Schema.Constraint | undefined =>
  Object.hasOwn(schemas, method) ? schemas[method] : undefined;

const requestSchemasFor = (peer: AcpPeer): SchemaMap => {
  switch (peer) {
    case AcpPeerValue.Agent: {
      return AGENT_REQUEST_SCHEMAS;
    }
    case AcpPeerValue.Client: {
      return CLIENT_REQUEST_SCHEMAS;
    }
    default: {
      return absurd(peer);
    }
  }
};

const notificationSchemasFor = (peer: AcpPeer): SchemaMap => {
  switch (peer) {
    case AcpPeerValue.Agent: {
      return AGENT_TO_CLIENT_NOTIFICATION_SCHEMAS;
    }
    case AcpPeerValue.Client: {
      return CLIENT_TO_AGENT_NOTIFICATION_SCHEMAS;
    }
    default: {
      return absurd(peer);
    }
  }
};

const resultSchemasFor = (
  direction: AcpPendingRequest["direction"]
): SchemaMap => {
  switch (direction) {
    case AcpRequestDirection.AgentToClient: {
      return AGENT_RESULT_SCHEMAS;
    }
    case AcpRequestDirection.ClientToAgent: {
      return CLIENT_RESULT_SCHEMAS;
    }
    default: {
      return absurd(direction);
    }
  }
};

const decodeWith = <S extends Schema.Constraint>(
  schema: S,
  value: unknown
): Effect.Effect<S["Type"], AcpSchemaDecodeError, S["DecodingServices"]> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(schemaFailure)
  );

const encodeWith = <S extends Schema.Constraint>(
  schema: S,
  value: unknown
): Effect.Effect<S["Encoded"], AcpSchemaDecodeError, S["EncodingServices"]> =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(schemaFailure)
  );

export {
  absurd,
  decodeWith,
  encodeWith,
  lookupSchema,
  notificationSchemasFor,
  requestSchemasFor,
  resultSchemasFor,
};
