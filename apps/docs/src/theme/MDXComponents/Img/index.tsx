import React, {useContext, type ReactNode} from 'react';
import Img from '@theme-original/MDXComponents/Img';
import type {Props} from '@theme/MDXComponents/Img';
import {useBlogPost} from '@docusaurus/plugin-content-blog/client';
import {FirstListedPostContext} from '@site/src/components/hero-image-context';

/** Props as they arrive from MDX: plugins/remark-hero-image.ts may add `data-hero`. */
type ImgProps = Props & {'data-hero'?: string};

/**
 * A blog post's hero image, loaded eagerly and at high priority when it is above
 * the fold: on the post's own page, or as the first post of a listing. Further
 * down a listing it stays lazy like every other image.
 *
 * Its own component because `useBlogPost` throws outside a blog post, and only
 * a blog post's hero ever carries `data-hero`.
 */
function HeroImg(props: Props): ReactNode {
  const {isBlogPostPage} = useBlogPost();
  const firstListed = useContext(FirstListedPostContext);
  const aboveTheFold = isBlogPostPage || firstListed;
  return aboveTheFold ? <Img {...props} loading="eager" fetchPriority="high" /> : <Img {...props} />;
}

/**
 * Markdown images. Every image keeps the theme's default (`loading="lazy"`)
 * except a blog post's hero; see {@link HeroImg}.
 *
 * @param props - The image's attributes from MDX.
 * @returns The image.
 */
export default function ImgWrapper({'data-hero': hero, ...props}: ImgProps): ReactNode {
  return hero ? <HeroImg {...props} /> : <Img {...props} />;
}
