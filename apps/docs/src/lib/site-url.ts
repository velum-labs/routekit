const DEFAULT_SITE_URL = "http://localhost:3000";

export function getSiteUrl(currentOrigin?: string): URL {
  const environment = typeof process === "undefined" ? undefined : process.env;
  const configured = environment?.NEXT_PUBLIC_DOCS_URL;
  if (configured) return new URL(configured);

  const deployment = environment?.VERCEL_URL;
  if (deployment) return new URL(`https://${deployment}`);

  if (currentOrigin) return new URL(currentOrigin);

  return new URL(DEFAULT_SITE_URL);
}
