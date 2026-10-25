import React, {type ReactNode} from 'react';
import {BlogPostProvider} from '@docusaurus/plugin-content-blog/client';
import BlogPostItem from '@theme/BlogPostItem';
import type {Props} from '@theme/BlogPostItems';
import {FirstListedPostContext} from '@site/src/components/hero-image-context';

/**
 * The theme's list of posts, with one change: the first post is marked through
 * {@link FirstListedPostContext}, so its hero image loads eagerly and at high
 * priority. On the blog index that image is the Largest Contentful Paint.
 *
 * Otherwise identical to `@docusaurus/theme-classic`'s BlogPostItems (3.10).
 * It cannot be a wrapper around the original, because the mark has to sit
 * inside the loop, around one item.
 *
 * @param props - The posts to list and the component that renders each one.
 * @returns The list.
 */
export default function BlogPostItems({items, component: BlogPostItemComponent = BlogPostItem}: Props): ReactNode {
  return (
    <>
      {items.map(({content: BlogPostContent}, index) => (
        <BlogPostProvider key={BlogPostContent.metadata.permalink} content={BlogPostContent}>
          <FirstListedPostContext.Provider value={index === 0}>
            <BlogPostItemComponent>
              <BlogPostContent />
            </BlogPostItemComponent>
          </FirstListedPostContext.Provider>
        </BlogPostProvider>
      ))}
    </>
  );
}
