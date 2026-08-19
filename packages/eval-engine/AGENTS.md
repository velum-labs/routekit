# Eval engine integration contract

- RouteKit application code integrates Ori only through the Effect `EvalEngine` and `EvalExecutionPort` layers composed by `@velum-labs/routekit-eval-service`.
- Ignore `HOST.md` for RouteKit integration. Do not spawn `ori-eval-system` or a second Ori host from RouteKit application packages.
- Keep `src/vendor/**` vendor-owned and unchanged. RouteKit FFI belongs in one adapter under `src/library/`.
- Never place an OpenRouter key or any credential-shaped value in the `node --test` child environment. Credentials stay in the scoped parent loopback bridge.
- Eval requests use explicit provider/model identifiers. Do not use `model: "auto"` inside evaluation.
