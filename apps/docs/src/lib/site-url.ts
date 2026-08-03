const DEFAULT_SITE_URL = "http://localhost:3000";

export function getSiteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_DOCS_URL;
  if (configured) return new URL(configured);

  const deployment = process.env.VERCEL_URL;
  if (deployment) return new URL(`https://${deployment}`);

  return new URL(DEFAULT_SITE_URL);
}
