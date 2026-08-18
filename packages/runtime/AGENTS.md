# Runtime architecture

- Runtime is a platform leaf. Keep process, filesystem, networking, lifecycle,
  service-control, token, and streaming concerns in shallow explicit modules.
- Effect services live at `src/services/<service>/service.ts`; do not add
  deeper service grouping or a services barrel.
- Prefer named subpath imports such as `./filesystem`, `./network`, `./process`,
  `./service`, and `./tokens`. Keep the root export as a thin published façade.
- Effect code uses platform services and scoped resource ownership where
  available. Promise, callback, and raw Node adapters belong at external
  boundaries.
- Generic runtime modules must not import CLI, daemon, gateway, or eval-service.
