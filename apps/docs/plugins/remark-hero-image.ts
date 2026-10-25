import fs from 'node:fs';
import nodePath from 'node:path';
import {GENERATED_STATIC_DIR, HERO_WIDTHS, findHeroImageUrl, variantUrl} from './blog-hero-image';

/** Options from the blog config. */
export interface RemarkHeroImageOptions {
  /** Absolute path of the Docusaurus site directory (`apps/docs`). */
  siteDir: string;
  /** The site's `baseUrl`, with its trailing slash (`/blog/`). */
  baseUrl: string;
}

/** The slice of an mdast/MDX node this plugin reads and writes. */
interface Node {
  type: string;
  name?: string | null;
  url?: string;
  attributes?: Array<{type: string; name?: string; value?: unknown}>;
  children?: Node[];
}

/** The first image in the tree, depth first: an `<img>` from `transformImage`, or a plain image node. */
function firstImage(node: Node): Node | null {
  if ((node.type === 'mdxJsxTextElement' || node.type === 'mdxJsxFlowElement') && node.name === 'img') return node;
  if (node.type === 'image') return null; // a remote image: never a hero
  for (const child of node.children ?? []) {
    const found = firstImage(child);
    if (found) return found;
  }
  return null;
}

/** Reads a string attribute's value, or undefined. */
function attr(node: Node, name: string): string | undefined {
  const value = node.attributes?.find((a) => a.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Marks a post's hero image so it loads first and at the right size.
 *
 * Adds `data-hero`, which `src/theme/MDXComponents/Img` turns into
 * `loading="eager"` and `fetchpriority="high"` when the image is above the fold
 * (on its own post page, or on the first post of a listing). And, when
 * `prebuild:blog` has written the smaller copies, adds `srcSet` and `sizes`, so
 * a phone downloads the 800 px copy instead of the 1600 px original.
 *
 * Registered in `remarkPlugins`, which Docusaurus runs after its own
 * `transformImage`, so the image is already an `<img>` element here, with the
 * `width` read from the file.
 *
 * @param options - The site directory and base URL.
 * @returns The remark transformer.
 */
export default function remarkHeroImage(options: RemarkHeroImageOptions) {
  return (tree: Node, file: {value?: unknown}): void => {
    const heroUrl = findHeroImageUrl(String(file.value ?? ''));
    if (!heroUrl) return;
    const img = firstImage(tree);
    if (!img || !img.attributes) return;

    img.attributes.push({type: 'mdxJsxAttribute', name: 'data-hero', value: 'true'});

    const width = Number(attr(img, 'width'));
    const widths = HERO_WIDTHS.filter((w) => w < width);
    const allWritten = widths.every((w) =>
      fs.existsSync(nodePath.join(options.siteDir, GENERATED_STATIC_DIR, variantUrl(heroUrl, w))),
    );
    if (widths.length === 0 || !allWritten) return;

    // Plain static URLs, not the hashed asset `src` points at: the copies are not
    // webpack modules. The original is listed too, so a wide screen still gets it.
    const toUrl = (url: string) => `${options.baseUrl}${url.replace(/^\//, '')}`;
    const srcSet = [
      ...widths.map((w) => `${toUrl(variantUrl(heroUrl, w))} ${w}w`),
      `${toUrl(heroUrl)} ${width}w`,
    ].join(', ');
    img.attributes.push({type: 'mdxJsxAttribute', name: 'srcSet', value: srcSet});
    // The post column: the full width less the page gutters on a phone or
    // tablet, and at most about 760 px beside the sidebar on a desktop.
    img.attributes.push({
      type: 'mdxJsxAttribute',
      name: 'sizes',
      value: '(max-width: 996px) calc(100vw - 32px), 760px',
    });
  };
}
