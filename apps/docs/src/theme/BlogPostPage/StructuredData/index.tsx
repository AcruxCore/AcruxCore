import type {ReactNode} from 'react';
import Head from '@docusaurus/Head';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useBlogPost, useBlogPostStructuredData} from '@docusaurus/plugin-content-blog/client';
import {ORGANIZATION_ID} from '../../../organization-id';

/**
 * A blog post's JSON-LD: Docusaurus's own BlogPosting, plus a publisher and a
 * breadcrumb trail. Ejected from `@theme/BlogPostPage/StructuredData`.
 *
 * - `publisher` points at the Organization by `@id`. The full Organization
 *   node (with its logo) is on every blog page through the config's head tags,
 *   so a crawler can resolve the reference on the page itself. The author stays
 *   whatever Docusaurus derives from authors.yml.
 * - The BreadcrumbList is Home > Blog > post, with Home on the marketing site,
 *   because the blog is a section of acruxcore.com.
 *
 * @returns The two JSON-LD scripts, rendered into the page head.
 */
export default function BlogPostStructuredData(): ReactNode {
  const posting = useBlogPostStructuredData();
  const {metadata} = useBlogPost();
  const {siteConfig} = useDocusaurusContext();
  const postUrl = `${siteConfig.url}${metadata.permalink}`;
  const blogUrl = `${siteConfig.url}${siteConfig.baseUrl}`;

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': `${postUrl}#breadcrumb`,
    itemListElement: [
      {'@type': 'ListItem', position: 1, name: 'Home', item: `${siteConfig.url}/`},
      {'@type': 'ListItem', position: 2, name: 'Blog', item: blogUrl},
      {'@type': 'ListItem', position: 3, name: metadata.title, item: postUrl},
    ],
  };

  return (
    <Head>
      <script type="application/ld+json">
        {JSON.stringify({...posting, publisher: {'@id': ORGANIZATION_ID}})}
      </script>
      <script type="application/ld+json">{JSON.stringify(breadcrumb)}</script>
    </Head>
  );
}
