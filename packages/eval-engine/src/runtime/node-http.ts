import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

export interface NodeHttpRequestIP {
  readonly address: string;
}

export interface NodeHttpServer {
  readonly hostname: string;
  readonly port: number;
  requestIP(request: Request): NodeHttpRequestIP | undefined;
  stop(closeActiveConnections?: boolean): void;
}

export interface NodeHttpServeOptions {
  readonly fetch: (
    request: Request,
    server: NodeHttpServer,
  ) => Response | Promise<Response>;
  readonly hostname: string;
  /** Seconds. `0` disables Node's socket/request timeouts. */
  readonly idleTimeout?: number;
  readonly port: number;
}

const incomingToRequest = (
  req: IncomingMessage,
  hostname: string,
  port: number,
): Request => {
  const url = `http://${hostname}:${port}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    body: hasBody ? (Readable.toWeb(req) as BodyInit) : undefined,
    duplex: hasBody ? "half" : undefined,
    headers,
    method,
  } as RequestInit);
};

const writeResponse = async (
  res: ServerResponse,
  response: Response,
): Promise<void> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream),
    res,
  );
};

/**
 * Loopback-capable HTTP server with a Fetch `Request`/`Response` handler.
 *
 * `listen` is async on Node, so this returns a Promise. Callers that previously
 * used a sync serve helper must switch to `Effect.tryPromise` / `Effect.promise`.
 */
export const serve = (
  options: NodeHttpServeOptions,
): Promise<NodeHttpServer> =>
  new Promise((resolve, reject) => {
    const requestIps = new WeakMap<Request, string>();
    const sockets = new Set<import("node:net").Socket>();
    let wrapper: NodeHttpServer;

    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const request = incomingToRequest(
            req,
            wrapper.hostname,
            wrapper.port,
          );
          const address = req.socket.remoteAddress;
          if (address !== undefined) {
            requestIps.set(request, address);
          }
          const response = await options.fetch(request, wrapper);
          await writeResponse(res, response);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        }
      })();
    });

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => {
        sockets.delete(socket);
      });
    });

    if (options.idleTimeout === 0) {
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      server.timeout = 0;
    } else if (options.idleTimeout !== undefined) {
      const milliseconds = options.idleTimeout * 1000;
      server.headersTimeout = milliseconds;
      server.requestTimeout = milliseconds;
      server.timeout = milliseconds;
    }

    wrapper = {
      hostname: options.hostname,
      port: options.port,
      requestIP: (request) => {
        const address = requestIps.get(request);
        return address === undefined ? undefined : { address };
      },
      stop: (closeActiveConnections = false) => {
        if (closeActiveConnections) {
          for (const socket of sockets) {
            socket.destroy();
          }
          sockets.clear();
        }
        server.close();
      },
    };

    server.once("error", reject);
    server.listen(options.port, options.hostname, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("HTTP server did not report a TCP address"));
        return;
      }
      wrapper = {
        ...wrapper,
        hostname: address.address === "::" ? options.hostname : address.address,
        port: address.port,
      };
      resolve(wrapper);
    });
  });
