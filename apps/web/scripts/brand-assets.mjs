/**
 * Regenerate the raster brand assets from the committed SVG sources.
 *
 *   node apps/web/scripts/brand-assets.mjs
 *
 * Everything here is derived, not hand-drawn — the SVGs in `public/` and
 * `public/brand/` are the source of truth. Re-run this after any change to the mark
 * or the lockup, and commit the PNGs it writes.
 *
 * Produces:
 *   apps/web/public/apple-touch-icon.png   180x180  iOS home screen
 *   apps/web/public/og-image.png          1200x630  social preview card
 *   apps/web/public/favicon.ico            16/32/48 multi-size, marketing + app
 *   apps/docs/static/img/favicon.ico       16/32/48 multi-size, docs site
 *
 * The .ico steps need ImageMagick (`magick`) on PATH and are skipped with a warning
 * if it is missing; the two PNGs only need Playwright, which is already a dev
 * dependency of this workspace.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '..');
const REPO = resolve(WEB, '../..');
const PUBLIC = join(WEB, 'public');
const DOCS_IMG = join(REPO, 'apps/docs/static/img');

/** Brand tokens, mirroring `apps/web/src/styles/tokens.css` (dark theme). */
const T = {
  bg: '#0b0e14',
  line: '#232a34',
  ink: '#e6eaf0',
  muted: '#8b94a3',
  faint: '#5c6472',
  accent: '#b6f400',
};

/** Inline an SVG file so the rendered page needs no file:// asset requests. */
function svg(relPath) {
  return readFileSync(join(PUBLIC, relPath), 'utf8');
}

/**
 * Screenshot one HTML string at an exact pixel size.
 *
 * @param browser - A live Playwright browser.
 * @param html - Full page body markup.
 * @param width - Viewport width in CSS px.
 * @param height - Viewport height in CSS px.
 * @param out - Absolute destination path for the PNG.
 * @param scale - Device pixel ratio; 1 keeps the output exactly width x height.
 */
async function shoot(browser, html, width, height, out, scale = 1) {
  const page = await browser.newPage({
    viewport: { width, height },
    deviceScaleFactor: scale,
  });
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>
       *{box-sizing:border-box}html,body{margin:0;padding:0}
       /* The source SVGs carry intrinsic width/height attributes, which otherwise
          win over the layout box they are dropped into. These two classes are how
          a caller says "fill this box" or "match this height". */
       .fill svg{display:block;width:100%;height:100%}
       .h svg{display:block;width:auto;height:100%}
     </style>${html}`,
    { waitUntil: 'load' },
  );
  await page.screenshot({ path: out, omitBackground: false });
  await page.close();
  console.log(`  wrote ${out.replace(`${REPO}/`, '')}  ${width}x${height}${scale > 1 ? ` @${scale}x` : ''}`);
}

const browser = await chromium.launch();
try {
  const icon = svg('favicon.svg');
  const icon16 = svg('brand/icon-16.svg');
  const lockup = svg('brand/lockup.svg');

  console.log('brand assets:');

  // --- apple-touch-icon: the tile bleeds to the edges, iOS applies its own mask.
  await shoot(
    browser,
    `<div class="fill" style="width:180px;height:180px;background:${T.bg}">
       ${icon.replace(/rx="14"/, 'rx="0"')}
     </div>`,
    180,
    180,
    join(PUBLIC, 'apple-touch-icon.png'),
  );

  // --- og-image: the social card. Rendered 1:1 — deviceScaleFactor would multiply
  //     the file's real dimensions, and index.html advertises og:image:width=1200,
  //     which crawlers check against the bytes they fetch.
  const og = `
    <div style="position:relative;width:1200px;height:630px;background:${T.bg};
                border:1px solid ${T.line};overflow:hidden;
                font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,Helvetica,Arial,sans-serif">
      <div style="position:absolute;top:-320px;left:420px;width:900px;height:640px;
                  background:radial-gradient(closest-side,rgba(182,244,0,.17),transparent 70%)"></div>
      <div class="h" style="position:absolute;top:64px;left:80px;height:34px">${lockup}</div>
      <div style="position:absolute;top:214px;left:80px;right:80px">
        <p style="margin:0 0 18px;color:${T.accent};font-size:21px;font-weight:700;
                  letter-spacing:.12em;text-transform:uppercase">LLM-ops for engineering teams</p>
        <h1 style="margin:0;color:${T.ink};font-size:62px;line-height:1.1;
                   letter-spacing:-.028em;font-weight:700;max-width:1040px">Version prompts, route LLM
          calls, trace and evaluate<span style="color:${T.accent}"> — one platform.</span></h1>
        <p style="margin:34px 0 0;color:${T.muted};font-size:24px;line-height:1.5">Ship, change, and
          measure LLM features without redeploying.</p>
      </div>
      <p style="position:absolute;bottom:44px;left:80px;margin:0;color:${T.faint};font-size:19px;
                font-family:ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace">acruxcore.com</p>
    </div>`;
  await shoot(browser, og, 1200, 630, join(PUBLIC, 'og-image.png'));

  // --- favicon.ico for both sites: 48 and 32 keep the dial, 16 uses the dial-less
  //     twin because the cut-out silts up into a smudge at that size.
  const tmp = mkdtempSync(join(tmpdir(), 'acx-ico-'));
  try {
    const layers = [];
    for (const [size, art] of [
      [48, icon],
      [32, icon],
      [16, icon16],
    ]) {
      const png = join(tmp, `ico-${size}.png`);
      await shoot(
        browser,
        `<div class="fill" style="width:${size}px;height:${size}px">${art}</div>`,
        size,
        size,
        png,
      );
      layers.push(png);
    }
    for (const dest of [join(PUBLIC, 'favicon.ico'), join(DOCS_IMG, 'favicon.ico')]) {
      try {
        execFileSync('magick', [...layers, dest], { stdio: 'pipe' });
        console.log(`  wrote ${dest.replace(`${REPO}/`, '')}  16/32/48`);
      } catch {
        console.warn(
          `  SKIPPED ${dest.replace(`${REPO}/`, '')} — ImageMagick (\`magick\`) not on PATH`,
        );
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} finally {
  await browser.close();
}
