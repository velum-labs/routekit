# CLI architecture

- Commands parse arguments, select a target, invoke a service, and render the
  result. Application workflows belong at `src/services/<service>/service.ts`.
- Keep exactly one directory per service below `src/services/`; do not group
  services into deeper feature trees and do not add a services barrel.
- SSH, keychain, native integration, process launch, and filesystem-specific
  implementations are platform adapters rather than application services.
- Avoid adding ambient CLI state. Pass values explicitly or provide an Effect
  service; keep Promise execution at the CLI/process boundary.
- The published CLI entrypoint is a thin façade. Internal file moves must not
  alter command names, options, output, or exit behavior.
