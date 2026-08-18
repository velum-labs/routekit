import { Option } from "effect";

import type { PiNativeConnectionError } from "./native/connection.ts";

const CLOSED_MESSAGE = {
  message: "Pi connection closed before the turn completed",
};

export const closedPromptFailure = (
  closed: Option.Option<PiNativeConnectionError>
): { readonly message: string } | PiNativeConnectionError =>
  Option.match(closed, {
    onNone: () => CLOSED_MESSAGE,
    onSome: (error) => (error.reason === "peer-exit" ? error : CLOSED_MESSAGE),
  });
