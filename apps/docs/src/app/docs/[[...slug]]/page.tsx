import { MarkdownCopyButton, ViewOptionsPopover } from "fumadocs-ui/layouts/docs/page";
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
  const markdownUrl = `${page.url}.md`;

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      editOnGithub={sourceLinks.editOnGithub}
      tableOfContent={{
        header: <p className="toc-eyebrow">ON THIS PAGE</p>
      }}
      className="routekit-doc-article"
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <div className="page-actions">
        <MarkdownCopyButton className="page-action" markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          className="page-action"
          githubUrl={sourceLinks.sourceUrl}
          markdownUrl={markdownUrl}
        >
          View options
        </ViewOptionsPopover>
      </div>
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
