import type { ValueOf } from "../../../../utils/core/src/types.ts";

export const ChangeClass = {
  Contribution: "contribution",
  FeatureAdded: "featureAdded",
  FeatureRemoved: "featureRemoved",
  Manifest: "manifest",
  Package: "package",
  // The workspace-root `routekit-eval.md` persona (RFC 0002 root-persona.md) is not a `features/*`
  // entry; it is re-read on every boot, so it affects no individual feature.
  RootPersona: "rootPersona",
} as const;
export type ChangeClass = ValueOf<typeof ChangeClass>;

export const ReloadOutcome = {
  Applied: "applied",
  Rejected: "rejected",
} as const;
export type ReloadOutcome = ValueOf<typeof ReloadOutcome>;
