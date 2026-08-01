type RouteTraceProps = {
  readonly model: string;
};

export function RouteTrace({ model }: RouteTraceProps) {
  const nativeModel = model.split("/").slice(1).join("/");

  return (
    <figure className="route-trace" aria-labelledby="route-trace-title">
      <div className="route-trace-bar">
        <span id="route-trace-title">EXPLAINED ROUTE</span>
        <span>REAL CATALOG FIELDS</span>
      </div>

      <div className="route-trace-body">
        <div className="trace-node trace-request">
          <span className="trace-kicker">INBOUND REQUEST</span>
          <strong>POST /v1/responses</strong>
          <code>{model}</code>
        </div>

        <div className="trace-path" aria-hidden="true">
          <span />
        </div>

        <div className="trace-node trace-gateway">
          <span className="trace-kicker">AUTHENTICATED GATEWAY</span>
          <strong>RouteKit resolves the namespace</strong>
          <span>127.0.0.1:8080</span>
        </div>

        <div className="trace-path trace-path-final" aria-hidden="true">
          <span />
        </div>

        <dl className="trace-result">
          <div>
            <dt>provider</dt>
            <dd>openai</dd>
          </div>
          <div>
            <dt>native model</dt>
            <dd>{nativeModel}</dd>
          </div>
          <div>
            <dt>account class</dt>
            <dd>api-key</dd>
          </div>
          <div>
            <dt>billing mode</dt>
            <dd>metered-api</dd>
          </div>
        </dl>

        <div className="trace-boundary">
          <span aria-hidden="true">✓</span>
          <p>
            <strong>Provider boundary preserved.</strong>
            <span>No silent cross-provider fallback.</span>
          </p>
        </div>
      </div>

      <figcaption>
        An illustrative request using fields exposed by <code>routekit models info</code>. A
        namespaced model remains attached to its provider and billing class.
      </figcaption>
    </figure>
  );
}
