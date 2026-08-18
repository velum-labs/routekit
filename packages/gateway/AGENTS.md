# Gateway architecture

- Gateway capabilities with injected dependencies or owned lifecycle live at
  `src/services/<service>/service.ts`. Keep the service directory flat and do
  not add a services barrel.
- Protocol codecs and provider wire translation remain adapters, not services.
  Endpoint modules adapt HTTP requests to services and must not become a second
  application layer.
- Keep routing policy, provider selection, model calls, health, and gateway
  lifecycle as explicit owners. Avoid broad modules that combine HTTP hosting,
  provider translation, and routing decisions.
- Large provider or codec files may remain cohesive. Split only at a genuine
  protocol, lifecycle, or ownership boundary.
- Preserve the root, `./protocol`, `./routing`, `./server`, and `./effect`
  package facades while narrowing internal imports.
