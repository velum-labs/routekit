import { Schema } from "effect";

import { AcpOptionalMeta } from "../primitives.ts";

type WithMeta<Fields extends Schema.Struct.Fields> = Schema.Struct<
  { readonly _meta: typeof AcpOptionalMeta } & Fields
>;

const withMeta = <Fields extends Schema.Struct.Fields>(
  fields: Fields
): WithMeta<Fields> =>
  Schema.Struct({
    _meta: AcpOptionalMeta,
    ...fields,
  });

const AcpSessionId = Schema.String;

const emptyResult = (): Schema.Struct<{
  readonly _meta: typeof AcpOptionalMeta;
}> => withMeta({});

export { AcpSessionId, emptyResult, withMeta };
export type { WithMeta };
