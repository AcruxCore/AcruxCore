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
 *   so a crawler can resolve the reference on the page itself.
 * - Each author Person gets `sameAs`: the profile links from its `socials` in
 *   authors.yml. Docusaurus emits name, title and url but drops the socials,
 *   and those links are what tie a byline to a real, findable person.
 * - The BreadcrumbList is Home > Blog > post, with Home on the marketing site,
 *   because the blog is a section of acruxcore.com.
 *
 * @returns The two JSON-LD scripts, rendered into the page head.
 */
type JsonLdNode = Record<string, unknown>;

/**
 * Adds `sameAs` to each Person in a BlogPosting's `author`, matched by name
 * against the post's authors.yml entries.
 *
 * @param author - The `author` Docusaurus derived: one node, an array, or absent.
 * @param socialsByName - Each author's social profile URLs, keyed by display name.
 * @returns The same shape with `sameAs` added where the author has socials.
 */
function withSameAs(author: unknown, socialsByName: Map<string, string[]>): unknown {
  const add = (node: JsonLdNode): JsonLdNode => {
    const links = socialsByName.get(String(node.name));
    return links && links.length > 0 ? {...node, sameAs: links} : node;
  };
  if (Array.isArray(author)) return (author as JsonLdNode[]).map(add);
  if (author && typeof author === 'object') return add(author as JsonLdNode);
  return author;
}

export default function BlogPostStructuredData(): ReactNode {
  const posting = useBlogPostStructuredData();
  const {metadata} = useBlogPost();
  const {siteConfig} = useDocusaurusContext();
  const socialsByName = new Map(
    metadata.authors
      .filter((a) => a.name)
      .map((a) => [a.name as string, Object.values(a.socials ?? {}).filter(Boolean) as string[]]),
  );
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
        {JSON.stringify({
          ...posting,
          author: withSameAs(posting.author, socialsByName),
          publisher: {'@id': ORGANIZATION_ID},
        })}
      </script>
      <script type="application/ld+json">{JSON.stringify(breadcrumb)}</script>
    </Head>
  );
}
