# eval-service contract

- eval-service is the Effect composition for offline evaluation and the only
  production package that imports eval-engine.
- Keep the primary service interface, Context identity, constructor, and open
  layer in `src/service.ts`.
- Keep the eval-engine adapter in `src/production-runner.ts`; do not expose
  eval-engine details through the service interface.
- Use `src/effect-api.ts` only as the published Effect façade.
- Internal files import precise sibling modules, never `src/index.ts`.
- Candidate, classifier, and judge model IDs must come from the authoritative
  `routekit.eval-manifest.json`.
- Evaluation requests require explicit provider/model IDs. `auto` is not an
  evaluation candidate.
- Validate the manifest before estimating or running a comparison.
- Cost estimates must report known pricing when the registry has pricing.
- Publish one `PublishedRoutingActivation` only after every required comparison
  succeeds and validates.
- Interruption, failure, or daemon restart must not expose a partial activation.
- Persist activation through eval-store rather than adding another store.
- Use Effect platform filesystem and path services.
- Own resources with scopes, acquisition/release, and finalizers.
- Keep expected failures in typed error channels.
- Do not add a second runner or restore `runEvalSuite`.
- Do not recreate the deleted profile protocol or eval-worker protocol.
- Do not modify eval-engine while changing this package.
- Run `pnpm --filter @velum-labs/routekit-eval-service build`.
- Run `pnpm --filter @velum-labs/routekit-eval-service test`.
- Run root `pnpm check` and offline `pnpm test` before completion.
