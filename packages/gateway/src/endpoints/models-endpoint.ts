import type { Backend } from "../backend.js";
import { cursorModelVariants } from "../adapters/cursor.js";
import { decodeModelCatalogPayload } from "../provider-protocol.js";
import type {
  EndpointAuthenticator,
  EndpointContext,
  EndpointJsonWriter,
  EndpointObserver
} from "./endpoint-module.js";
import { GatewayEndpoint } from "./endpoint-module.js";

export type ModelsOperation = "catalog" | "cursor-catalog" | "retrieve";

type ModelsRequest = Readonly<{ context: EndpointContext; operation: ModelsOperation }>;

type CodexCatalogRelay = Readonly<{
  mergedCatalog(
    headers: EndpointContext["request"]["headers"],
    search: string
  ): Promise<{ models: Array<Record<string, unknown>>; etag?: string } | undefined>;
  mergeDataIds(
    data: Array<{ id: string } & Record<string, unknown>>,
    models: readonly Record<string, unknown>[]
  ): Array<{ id: string } & Record<string, unknown>>;
}>;

export type ModelsEndpointDependencies = Readonly<{
  backend: Backend;
  anthropicRelayAvailable: boolean;
  anthropicCatalog?(
    context: EndpointContext,
    configured: Response
  ): Promise<Response>;
  codexCatalog?: CodexCatalogRelay;
  includeCodexNativeModels: boolean;
  configuredAnthropicCatalog(): Response;
  pickerModels(
    configured: Array<{ id: string } & Record<string, unknown>>,
    native: readonly Record<string, unknown>[],
    includeUnroutedNative: boolean
  ): Record<string, unknown>[];
  resolveRetrieval(id: string):
    | Readonly<{ status: "ok"; displayName: string }>
    | Readonly<{ status: "invalid"; message: string }>
    | Readonly<{ status: "missing" }>;
  writeJson: EndpointJsonWriter;
  pipe(response: EndpointContext["response"], upstream: Response): Promise<void>;
}>;

export class ModelsEndpoint extends GatewayEndpoint<
  ModelsOperation,
  ModelsRequest,
  ModelsRequest,
  ModelsRequest,
  ModelsRequest
> {
  constructor(
    authenticate: EndpointAuthenticator,
    dependencies: ModelsEndpointDependencies,
    observe?: EndpointObserver
  ) {
    super(
      "models",
      authenticate,
      {
        decode: (context, operation) => ({ context, operation }),
        resolve: (request) => request,
        execute: async (request) => {
          await executeModelsRequest(dependencies, request);
          return request;
        },
        observe: (request) => request,
        encode: () => {}
      },
      observe
    );
  }

  matches(method: string, path: string): boolean {
    return (
      method === "GET" &&
      (path === "/v1/models" ||
        path === "/models" ||
        path === "/backend-api/codex/models" ||
        path === "/v1/cursor/models" ||
        path.startsWith("/v1/models/"))
    );
  }

  protected decodeOperation(context: EndpointContext): ModelsOperation {
    if (context.url.pathname === "/v1/cursor/models") return "cursor-catalog";
    if (context.url.pathname.startsWith("/v1/models/")) return "retrieve";
    return "catalog";
  }
}

async function executeModelsRequest(
  dependencies: ModelsEndpointDependencies,
  request: ModelsRequest
): Promise<void> {
  const { context, operation } = request;
  const { backend, writeJson, pipe } = dependencies;
  const { request: incoming, response, url } = context;

  if (operation === "catalog") {
    if (incoming.headers["anthropic-version"] !== undefined) {
      const configured = dependencies.configuredAnthropicCatalog();
      await pipe(
        response,
        dependencies.anthropicCatalog === undefined
          ? configured
          : await dependencies.anthropicCatalog(context, configured)
      );
      return;
    }
    if (dependencies.codexCatalog !== undefined) {
      const merged = await dependencies.codexCatalog.mergedCatalog(
        incoming.headers,
        url.search
      );
      if (merged !== undefined) {
        const base = decodeModelCatalogPayload(
          await (await backend.models()).json(),
          "gateway-backend"
        );
        if (merged.etag !== undefined && dependencies.includeCodexNativeModels) {
          response.setHeader("etag", merged.etag);
        }
        const data = dependencies.includeCodexNativeModels
          ? dependencies.codexCatalog.mergeDataIds(base.data, merged.models)
          : base.data;
        writeJson(response, 200, {
          object: "list",
          default_model: backend.defaultModel,
          data,
          models: dependencies.pickerModels(
            base.data,
            merged.models,
            dependencies.includeCodexNativeModels
          )
        });
        return;
      }
    }
    const modelResponse = await backend.models();
    if (!modelResponse.ok) {
      await pipe(response, modelResponse);
      return;
    }
    const modelPayload = decodeModelCatalogPayload(
      await modelResponse.json(),
      "gateway-backend"
    );
    writeJson(response, 200, {
      ...modelPayload,
      object: typeof modelPayload.object === "string" ? modelPayload.object : "list",
      default_model: backend.defaultModel,
      models: dependencies.pickerModels(modelPayload.data, [], false)
    });
    return;
  }

  if (operation === "cursor-catalog") {
    const upstream = await backend.models();
    if (!upstream.ok) {
      await pipe(response, upstream);
      return;
    }
    const payload = decodeModelCatalogPayload(
      await upstream.json(),
      "gateway-backend"
    );
    writeJson(response, 200, {
      ...payload,
      data: payload.data.flatMap((entry) =>
        cursorModelVariants(entry.id, entry.reasoning).map((variant) => ({
          ...entry,
          id: variant.model
        }))
      )
    });
    return;
  }

  const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
  const result = dependencies.resolveRetrieval(id);
  if (result.status === "invalid") {
    writeJson(response, 400, {
      type: "error",
      error: { type: "invalid_request_error", message: result.message }
    });
    return;
  }
  if (result.status === "missing") {
    writeJson(response, 404, {
      error: { message: `unknown model: ${id}`, type: "not_found" }
    });
    return;
  }
  writeJson(response, 200, {
    type: "model",
    id,
    display_name: result.displayName,
    created_at: new Date(0).toISOString()
  });
}
