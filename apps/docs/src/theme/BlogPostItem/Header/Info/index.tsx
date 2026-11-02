import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import {translate} from '@docusaurus/Translate';
import {usePluralForm} from '@docusaurus/theme-common';
import {useDateTimeFormat} from '@docusaurus/theme-common/internal';
import {useBlogPost} from '@docusaurus/plugin-content-blog/client';
import type {Props} from '@theme/BlogPostItem/Header/Info';

import styles from './styles.module.css';

/** Returns a formatter for "N min read", pluralised the way the theme does it. */
function useReadingTimePlural(): (readingTimeFloat: number) => string {
  const {selectMessage} = usePluralForm();
  return (readingTimeFloat: number) => {
    const readingTime = Math.ceil(readingTimeFloat);
    return selectMessage(
      readingTime,
      translate(
        {
          id: 'theme.blog.post.readingTime.plurals',
          description: 'Pluralized label for "{readingTime} min read"',
          message: 'One min read|{readingTime} min read',
        },
        {readingTime},
      ),
    );
  };
}

/** The UTC calendar day of a date, as `YYYY-MM-DD`. */
function utcDay(value: string | number): string {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * The line under a post's title: publish date, last-updated date, reading time.
 *
 * Same as `@docusaurus/theme-classic`'s BlogPostItem/Header/Info (3.10), plus
 * a "Published" label and an "Updated" date. The theme prints the updated date
 * only in the footer, under the whole post, where a reader never sees it. It
 * comes from the post's
 * `last_update.date` front matter, and is left out when it falls on the
 * publish day, so a new post does not say "Updated" on the day it went out.
 *
 * @param props - The theme's props; only `className` is used.
 * @returns The info line.
 */
export default function BlogPostItemHeaderInfo({className}: Props): ReactNode {
  const {metadata} = useBlogPost();
  const {date, readingTime, lastUpdatedAt} = metadata;
  const readingTimePlural = useReadingTimePlural();

  const dateTimeFormat = useDateTimeFormat({
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const formatDate = (value: string | number) => dateTimeFormat.format(new Date(value));

  const showUpdated = lastUpdatedAt != null && utcDay(lastUpdatedAt) !== utcDay(date);

  return (
    <div className={clsx(styles.container, 'margin-vert--md', className)}>
      <span className={styles.noWrap}>
        Published <time dateTime={date}>{formatDate(date)}</time>
      </span>
      {showUpdated && (
        <>
          {' · '}
          <span className={styles.noWrap}>
            Updated{' '}
            <time dateTime={new Date(lastUpdatedAt).toISOString()}>{formatDate(lastUpdatedAt)}</time>
          </span>
        </>
      )}
      {typeof readingTime !== 'undefined' && (
        <>
          {' · '}
          <span className={styles.noWrap}>{readingTimePlural(readingTime)}</span>
        </>
      )}
    </div>
  );
}
