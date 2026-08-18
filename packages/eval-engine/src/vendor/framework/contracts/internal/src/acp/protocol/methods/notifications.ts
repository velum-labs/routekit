import type { Schema } from "effect";

import { AcpRequestId } from "../primitives.ts";

import { withMeta } from "./common.ts";

const CancelRequestNotification = withMeta({ requestId: AcpRequestId });

const protocolNotificationSchemas = {
  "$/cancel_request": CancelRequestNotification,
} as const satisfies Readonly<Record<string, Schema.Top>>;

export { protocolNotificationSchemas };
