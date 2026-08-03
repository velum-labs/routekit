---
"@velum-labs/routekit": patch
---

Isolate supervised daemons from launchd and systemd provider variables. Direct
provider credentials and resolved base URLs are captured explicitly, while
native-client overrides and absent AWS credential-chain inputs are deleted
before provider configuration loads. Existing supervised services can refresh
the contract with `routekit daemon service install`.
