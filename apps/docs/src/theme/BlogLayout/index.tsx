import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Layout from '@theme/Layout';
import type {Props} from '@theme/BlogLayout';

/**
 * The blog's page frame, without the "Recent posts" sidebar.
 *
 * The theme's default gave that list 3 of 12 columns on every post, which left a post 7
 * columns, so a six-column comparison table wrapped into tall cells. The blog index
 * already lists every post and each post ends with related links, so the list was
 * repeated navigation. `blogSidebarCount: 0` in docusaurus.blog.config.ts stops it being
 * built at all; this layout gives its width to the post.
 *
 * A post with a table of contents gets 9 columns and the contents 3. A page without one
 * (the index, a tag page) is centred in 8 columns, a comfortable width for a list of cards.
 *
 * @param props - The theme's BlogLayout props; `sidebar` is ignored.
 * @returns The page.
 */
export default function BlogLayout({sidebar: _sidebar, toc, children, ...layoutProps}: Props): ReactNode {
  return (
    <Layout {...layoutProps}>
      <div className="container margin-vert--lg acx-blog-container">
        <div className="row">
          <main className={clsx('col', toc ? 'col--9' : 'col--8 col--offset-2')}>{children}</main>
          {toc && <div className="col col--3">{toc}</div>}
        </div>
      </div>
    </Layout>
  );
}
