import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const siteUrl = getSiteUrl();

  return [
    { url: siteUrl.toString() },
    ...source.getPages().map((page) => ({
      url: new URL(page.url, siteUrl).toString()
    }))
  ];
}
