export function QuickstartTerminal() {
  return (
    <div className="quickstart-terminal" aria-label="RouteKit quick start terminal">
      <div className="terminal-bar">
        <span>QUICK START</span>
        <span>SH</span>
      </div>
      <pre>
        <code>{`$ curl -fsSL https://github.com/velum-labs/routekit/releases/latest/download/install.sh | sh
$ export OPENAI_API_KEY='your-key'
$ routekit config init
$ routekit start
$ routekit models list`}</code>
      </pre>
      <div className="expected-output">
        <span className="status-dot" aria-hidden="true" /> <strong>EXPECTED</strong>
        <span>Gateway ready at http://127.0.0.1:8080 with namespaced models listed.</span>
      </div>
    </div>
  );
}
