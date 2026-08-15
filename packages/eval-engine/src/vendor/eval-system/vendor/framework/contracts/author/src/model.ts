// RFC 0002 root-persona.md: the default-model value. Selected statically from a workspace's
// root `routekit-eval.md` frontmatter. There is no `feature.ts` `model`/`getModel` export and no
// per-invocation dynamic resolver: `routekit-eval.md` is static YAML, so a slug or `null` is all
// it expresses.
export type GatewayModelSlug = `${string}/${string}`;

export type ModelSlug = GatewayModelSlug;

export type ModelValue = ModelSlug | null;
