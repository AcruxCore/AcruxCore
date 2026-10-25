// Writes smaller copies of every blog post's hero image, for `srcset`.
//
// Runs before every blog build and dev server (`prebuild:blog`, `prestart:blog`).
// The copies go to static-generated/, which is gitignored: they are derived from
// the originals in static/, so committing them would only let the two drift.
// A copy newer than its original is left alone, so a rebuild costs nothing.
//
// Usage: node --experimental-strip-types scripts/blog-image-variants.ts
import fs from 'node:fs';
import nodePath from 'node:path';
import sharp from 'sharp';
import {GENERATED_STATIC_DIR, HERO_WIDTHS, findHeroImageUrl, variantUrl} from '../plugins/blog-hero-image.ts';

const SITE_DIR = nodePath.resolve(import.meta.dirname, '..');
const BLOG_DIR = nodePath.join(SITE_DIR, 'blog');

let written = 0;
let current = 0;
for (const name of fs.readdirSync(BLOG_DIR).filter((f) => /\.mdx?$/.test(f)).sort()) {
  const heroUrl = findHeroImageUrl(fs.readFileSync(nodePath.join(BLOG_DIR, name), 'utf8'));
  if (!heroUrl) continue;
  const original = nodePath.join(SITE_DIR, 'static', heroUrl);
  if (!fs.existsSync(original)) {
    throw new Error(`${name}: hero image ${heroUrl} is not in static/`);
  }
  const {width = 0} = await sharp(original).metadata();
  for (const w of HERO_WIDTHS.filter((candidate) => candidate < width)) {
    const target = nodePath.join(SITE_DIR, GENERATED_STATIC_DIR, variantUrl(heroUrl, w));
    if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(original).mtimeMs) {
      current += 1;
      continue;
    }
    fs.mkdirSync(nodePath.dirname(target), {recursive: true});
    await sharp(original).resize({width: w}).webp({quality: 80}).toFile(target);
    written += 1;
  }
}
console.log(`[blog-image-variants] wrote ${written} hero image copies, ${current} already current.`);
