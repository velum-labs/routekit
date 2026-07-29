import { notFound } from "next/navigation";
import { ImageResponse } from "next/og";
import { OG_IMAGE_SIZE, OgCard } from "@/components/og-card";
import { loadBrandMark, sectionLabel } from "@/lib/og-image";
import { getPageImageUrl, source } from "@/lib/source";

export const revalidate = false;

export async function GET(_request: Request, props: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await props.params;
  if (slug.at(-1) !== "image.png") notFound();

  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <OgCard
      title={page.data.title}
      description={page.data.description}
      section={sectionLabel(page.slugs)}
      brandMark={await loadBrandMark()}
    />,
    OG_IMAGE_SIZE
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: getPageImageUrl(page).segments }));
}
