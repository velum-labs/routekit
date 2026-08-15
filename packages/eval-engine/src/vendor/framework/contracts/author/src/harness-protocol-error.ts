import { Schema } from "effect";

/** `<domain> error: <detail>` — the shared message shape for detail-bearing errors. */
export const detailErrorMessage = (domain: string, detail: string): string =>
  `${domain} error: ${detail}`;

export class HarnessProtocolError extends Schema.TaggedErrorClass<HarnessProtocolError>()(
  "HarnessProtocolError",
  {
    cause: Schema.optionalKey(Schema.Defect()),
    detail: Schema.String,
    line: Schema.optionalKey(Schema.String),
  }
) {
  override readonly message = detailErrorMessage(
    "Harness protocol",
    this.detail
  );
}
