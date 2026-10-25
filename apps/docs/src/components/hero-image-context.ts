import {createContext} from 'react';

/**
 * True for the first post of a blog listing (the index, a tag page, an author
 * page), whose hero image is above the fold. Every other listed post keeps its
 * hero lazy, so the index does not fetch ten large images at high priority.
 *
 * Set by `src/theme/BlogPostItems`, read by `src/theme/MDXComponents/Img`. A
 * post's own page does not need it: that page has one post, and its hero is
 * always at the top.
 */
export const FirstListedPostContext = createContext(false);
