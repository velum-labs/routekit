const REPOSITORY_URL = "https://github.com/velum-labs/routekit";
const AUTHORED_DOCS_ROOT = "apps/docs/content/docs";

type SourceMetadata = {
  sourcePath?: unknown;
  sourceUrl?: unknown;
  editPath?: unknown;
  editUrl?: unknown;
  generated?: unknown;
};

export type PageSourceLinks = {
  sourceUrl?: string;
  editOnGithub?: { owner: string; repo: string; sha: string; path: string };
};

function githubUrl(action: "blob" | "edit", path: string): string {
  return `${REPOSITORY_URL}/${action}/main/${path}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function resolvePageSourceLinks(page: {
  path: string;
  data: SourceMetadata;
}): PageSourceLinks {
  const data = page.data;
  const sourceUrl = stringValue(data.sourceUrl);
  const editUrl = stringValue(data.editUrl);
  const sourcePath = stringValue(data.sourcePath);
  const editPath = stringValue(data.editPath);
  const authoredPath = page.path.endsWith(".mdx")
    ? `${AUTHORED_DOCS_ROOT}/${page.path}`
    : undefined;
  const resolvedSourcePath = sourcePath ?? authoredPath;
  const resolvedEditPath = editPath ?? (data.generated ? undefined : resolvedSourcePath);

  const resolvedEditUrl =
    editUrl ?? (resolvedEditPath ? githubUrl("edit", resolvedEditPath) : undefined);
  const editOnGithub =
    !editUrl && resolvedEditPath
      ? { owner: "velum-labs", repo: "routekit", sha: "main", path: resolvedEditPath }
      : undefined;

  return {
    sourceUrl:
      sourceUrl ?? (resolvedSourcePath ? githubUrl("blob", resolvedSourcePath) : resolvedEditUrl),
    editOnGithub
  };
}
