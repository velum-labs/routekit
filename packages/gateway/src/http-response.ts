import type { ServerResponse } from "node:http";

export function writeJson(res: ServerResponse, status: number, value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", String(payload.byteLength));
  res.end(payload);
  return payload;
}

export function waitForDrainOrClose(res: ServerResponse): Promise<"drain" | "close"> {
  if (res.destroyed) return Promise.resolve("close");
  return new Promise((resolve) => {
    const settle = (event: "drain" | "close"): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      resolve(event);
    };
    const onDrain = (): void => settle("drain");
    const onClose = (): void => settle("close");
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

export function jsonResponse(value: unknown, status?: number, headers?: Headers): Response;
export function jsonResponse(status: number, value: unknown, headers?: Headers): Response;
export function jsonResponse(
  valueOrStatus: unknown,
  statusOrValue: number | unknown = 200,
  headers?: Headers
): Response {
  const status =
    typeof valueOrStatus === "number"
      ? valueOrStatus
      : typeof statusOrValue === "number"
        ? statusOrValue
        : 200;
  const value = typeof valueOrStatus === "number" ? statusOrValue : valueOrStatus;
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...(headers?.get("x-request-id") !== null
        ? { "x-request-id": headers?.get("x-request-id") ?? "" }
        : {})
    }
  });
}

export function copyFailure(response: Response, text: string): Response {
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}
