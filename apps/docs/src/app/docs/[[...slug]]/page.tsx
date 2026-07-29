import { createRelativeLink } from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FeedbackPopover } from "@/components/feedback-popover";
import { getMDXComponents } from "@/components/mdx";
import { source } from "@/lib/source";
import { resolvePageSourceLinks } from "@/lib/source-links";

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const sourceLinks = resolvePageSourceLinks(page);

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      editOnGithub={sourceLinks.editOnGithub}
      tableOfContent={{
        header: <p className="toc-eyebrow">ON THIS PAGE</p>,
        footer: (
          <>
            {sourceLinks.sourceUrl ? (
              <a className="toc-source-link" href={sourceLinks.sourceUrl}>
                View source ↗
              </a>
            ) : null}
            <a className="toc-source-link" href={`${page.url}.md`}>
              View as Markdown ↗
            </a>
          </>
        )
      }}
      article={{ className: "routekit-doc-article" }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <FeedbackPopover>
          <MDX components={getMDXComponents({ a: createRelativeLink(source, page) })} />
        </FeedbackPopover>
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
