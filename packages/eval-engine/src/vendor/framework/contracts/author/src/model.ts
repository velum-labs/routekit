// RFC 0002 root-persona.md: the default-model value. Selected statically from a workspace's
// root `ori.md` frontmatter. There is no `feature.ts` `model`/`getModel` export and no
// per-invocation dynamic resolver: `ori.md` is static YAML, so a slug or `null` is all
// it expresses.
export type OpenRouterModelSlug = `${string}/${string}`;

export type ModelSlug = OpenRouterModelSlug;

export type ModelValue = ModelSlug | null;
