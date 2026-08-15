import { Schema } from "effect";

import {
  AcpOptionalNullable,
  AcpTolerantArray,
} from "../primitives.ts";

import { emptyResult, withMeta } from "./common.ts";

const AcpAuthMethod = withMeta({
  description: AcpOptionalNullable(Schema.String),
  id: Schema.String,
  name: Schema.String,
});

const AuthenticateRequest = withMeta({ methodId: Schema.String });
const AuthenticateResult = emptyResult();
const LogoutRequest = withMeta({});
const LogoutResult = emptyResult();

const authenticationRequestSchemas = {
  authenticate: AuthenticateRequest,
  logout: LogoutRequest,
} as const;
const authenticationResultSchemas = {
  authenticate: AuthenticateResult,
  logout: LogoutResult,
} as const satisfies Record<
  keyof typeof authenticationRequestSchemas,
  Schema.Top
>;

const AcpAuthMethods = AcpTolerantArray(AcpAuthMethod);

export {
  AcpAuthMethods,
  authenticationRequestSchemas,
  authenticationResultSchemas,
};
