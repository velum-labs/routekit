type RouteTraceProps = {
  readonly model: string;
};

export function RouteTrace({ model }: RouteTraceProps) {
  return (
    <figure className="route-trace" aria-labelledby="route-trace-title">
      <div className="route-trace-bar">
        <span id="route-trace-title">ONE MODEL, A DIFFERENT TOOL</span>
        <span>REAL CLI FLOW</span>
      </div>

      <div className="route-trace-body">
        <div className="trace-node trace-request">
          <span className="trace-kicker">CODING TOOL</span>
          <strong>Claude Code</strong>
          <code>routekit claude {model}</code>
        </div>

        <div className="trace-path" aria-hidden="true">
          <span />
        </div>

        <div className="trace-node trace-gateway">
          <span className="trace-kicker">ROUTEKIT</span>
          <strong>Connects the tool to the route</strong>
          <span>one local or shared gateway</span>
        </div>

        <div className="trace-path trace-path-final" aria-hidden="true">
          <span />
        </div>

        <dl className="trace-result">
          <div>
            <dt>coding tool</dt>
            <dd>Claude Code</dd>
          </div>
          <div>
            <dt>model route</dt>
            <dd>{model}</dd>
          </div>
          <div>
            <dt>access</dt>
            <dd>Codex subscription</dd>
          </div>
          <div>
            <dt>account pool</dt>
            <dd>personal + work</dd>
          </div>
        </dl>

        <div className="trace-boundary">
          <span aria-hidden="true">✓</span>
          <p>
            <strong>Tool and model are independent.</strong>
            <span>The Codex subscription route stays explicit.</span>
          </p>
        </div>
      </div>

      <figcaption>
        This example opens a Codex subscription model in Claude Code. RouteKit adapts the request
        and selects an eligible Codex account.
      </figcaption>
    </figure>
  );
}
