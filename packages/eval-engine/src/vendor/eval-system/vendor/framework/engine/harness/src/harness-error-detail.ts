import { formatUnknownError } from "../../../utils/core/src/error-formatting.ts";

const truncateMessage = (message: string): string => {
  const limit = 300;
  return message.length <= limit ? message : `${message.slice(0, limit)}...`;
};

export const formatHarnessFailureDetail = (
  harnessName: string,
  operation: string,
  cause: unknown
): string => {
  const messages: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < 2; depth += 1) {
    messages.push(truncateMessage(formatUnknownError(current)));
    current = current instanceof Error ? current.cause : undefined;
    if (current === undefined) {
      break;
    }
  }
  return `Harness "${harnessName}" ${operation}: ${messages.join(" ← ")}`;
};
