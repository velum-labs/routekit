# `@velum-labs/routekit-daemon`

Composition root for RouteKit's singleton daemon.

A stable cluster primary owns singleton authority, service records, the shared
control/data listener handles, Portless registration, and the managed
CLIProxyAPI sidecar. One active worker owns the RouteKit control plane, router
generations, account state, and telemetry. Config/account changes replace the
inner router generation; restart and upgrade replace the worker while the
primary and public ports remain stable. Failed candidates leave the active
worker serving traffic.

`startRouteKitDaemon` remains the standalone composition root for embedders and
tests. Production `routekit daemon run` uses `startRouteKitDaemonHost` in the
primary and `runRouteKitDaemonWorker` in cluster workers.

Applications normally use it through `@velum-labs/routekit`. Tests and specialized
hosts can acquire a scoped gateway generation from `@velum-labs/routekit-daemon/effect`
without claiming the singleton service record.
