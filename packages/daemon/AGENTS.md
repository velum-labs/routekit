# Daemon architecture

- Daemon capabilities implemented as Effect services live at
  `src/services/<service>/service.ts`. Do not add a nested domain level or a
  `services/index.ts` barrel.
- `src/application-services.ts` is the application composition root. It may
  assemble services but must not absorb their behavior.
- Keep control dispatch and wire adaptation outside services. Keep durable and
  in-memory state representations in explicit state/store modules.
- Host, worker, generation, and lifecycle resources must have one clear owner.
  Prefer scoped Effect acquisition and finalization over adding another cleanup
  registry or manually retained started/fiber state.
- Gateway-generation composition belongs in
  `src/services/gateway-generation/service.ts`. Keep its account sets, provider
  backend, and listener in one native Effect scope; do not reintroduce the
  standalone router package.
- Keep the public root, `./state`, and `./effect` as thin published façades.
  Internal modules import precise service files instead.
