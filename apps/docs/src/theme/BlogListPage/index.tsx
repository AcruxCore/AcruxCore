import type {ReactNode} from 'react';
import clsx from 'clsx';
import {HtmlClassNameProvider, PageMetadata, ThemeClassNames} from '@docusaurus/theme-common';
import BlogLayout from '@theme/BlogLayout';
import BlogListPaginator from '@theme/BlogListPaginator';
import SearchMetadata from '@theme/SearchMetadata';
import BlogPostItems from '@theme/BlogPostItems';
import BlogListPageStructuredData from '@theme/BlogListPage/StructuredData';
import type {Props} from '@theme/BlogListPage';

/**
 * The blog's post list (`/blog/` and `/blog/page/N`). Ejected from
 * `@theme/BlogListPage` for one change: a visible `<h1>` and one-line intro
 * above the posts. The stock page has no heading at all — each post title is an
 * `<h2>` — so the page's topic was stated nowhere a reader or crawler looks
 * first. The heading is `blogTitle` and the intro is `blogDescription` from
 * docusaurus.blog.config.ts, so the `<title>`, the meta description and the
 * visible text cannot drift apart.
 *
 * @param props - The list page props Docusaurus passes in.
 * @returns The list page.
 */
export default function BlogListPage(props: Props): ReactNode {
  const {metadata, items, sidebar} = props;
  const {blogTitle, blogDescription} = metadata;
  return (
    <HtmlClassNameProvider
      className={clsx(ThemeClassNames.wrapper.blogPages, ThemeClassNames.page.blogListPage)}>
      <PageMetadata title={blogTitle} description={blogDescription} />
      <SearchMetadata tag="blog_posts_list" />
      <BlogListPageStructuredData {...props} />
      <BlogLayout sidebar={sidebar}>
        <header className="margin-bottom--xl">
          <h1>{blogTitle}</h1>
          <p className="text--lg margin-bottom--none">{blogDescription}</p>
        </header>
        <BlogPostItems items={items} />
        <BlogListPaginator metadata={metadata} />
      </BlogLayout>
    </HtmlClassNameProvider>
  );
}
