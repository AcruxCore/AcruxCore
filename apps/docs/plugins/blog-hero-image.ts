// Which image is a blog post's "hero" — the header image at the top of the post —
// and where its smaller copies live. Shared by the build step that writes the
// copies (scripts/blog-image-variants.ts) and the remark plugin that points the
// <img> at them (plugins/remark-hero-image.ts), so the two cannot disagree on
// which image or which file names.
//
// Why it exists: the hero is the Largest Contentful Paint element on the blog
// index and on every post that has one. Lighthouse measured it at 6.3 s on the
// index (mobile), because it was a 1600 px wide file, lazy-loaded, shown about
// 380 px wide on a phone.

/** Widths, in pixels, of the smaller copies written next to each hero image. */
export const HERO_WIDTHS = [480, 800, 1200] as const;

/**
 * Folder, relative to the site directory, that holds the generated copies.
 * Listed in the blog config's `staticDirectories` and in .gitignore: the copies
 * are build output, written fresh by `prebuild:blog`, never committed.
 */
export const GENERATED_STATIC_DIR = 'static-generated';

/** Raster formats a browser can pick from `srcset`. An SVG has no width to choose by. */
const RASTER = /\.(webp|png|jpe?g)$/i;

/** The marker that ends a post's excerpt on the blog index. */
const TRUNCATE = /<!--\s*truncate\s*-->|\{\/\*\s*truncate\s*\*\/\}/;

/** The first Markdown image in a source, with its URL. */
const FIRST_IMAGE = /!\[[^\]]*\]\((\/img\/[^)\s]+)\)/;

/**
 * The URL of a post's hero image, or null when the post has none.
 *
 * The hero is the first Markdown image, as long as it comes before the
 * `<!-- truncate -->` marker — which is what puts it on the blog index as well
 * as on the post. An image further down is never above the fold.
 *
 * @param source - The post's Markdown, front matter included or not.
 * @returns A site-relative static URL such as `/img/blog/x/01-header.webp`, or null.
 */
export function findHeroImageUrl(source: string): string | null {
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
  const truncateAt = body.search(TRUNCATE);
  const excerpt = truncateAt === -1 ? body : body.slice(0, truncateAt);
  const url = excerpt.match(FIRST_IMAGE)?.[1] ?? null;
  return url && RASTER.test(url) ? url : null;
}

/**
 * The URL of one smaller copy of an image: `/img/a/b.webp` at 480 becomes
 * `/img/a/b-480w.webp`. Every copy is WebP, whatever the original format.
 *
 * @param url - A site-relative static URL of the original.
 * @param width - One of {@link HERO_WIDTHS}.
 * @returns The copy's site-relative URL.
 */
export function variantUrl(url: string, width: number): string {
  return url.replace(RASTER, `-${width}w.webp`);
}
