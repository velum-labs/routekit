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
- Preserve the public root, `./state`, and `./effect` package facades when
  moving internal modules.
