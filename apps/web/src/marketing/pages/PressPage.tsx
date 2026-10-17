import { type ReactNode } from 'react';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { cssToStyle } from '../marketing-chrome';

/**
 * One directory that lists AcruxCore and gives a badge to show in return.
 *
 * Some directories only grant their backlink after their crawler finds the badge
 * on our site, so every field is copied verbatim from the directory's own badge
 * snippet — the link target, the hotlinked image and any `data-*` marker the
 * crawler matches on. Do not rehost the image or shorten the URL.
 */
interface DirectoryBadge {
  name: string;
  href: string;
  imgSrc: string;
  alt: string;
  title?: string;
  /** Extra attributes from the snippet that the directory's crawler looks for. */
  dataAttrs?: Record<string, string>;
  /** Intrinsic image size in pixels, so the badge keeps its own aspect ratio. */
  width: number;
  height: number;
}

/** Every badge renders at this height; the width follows each image's own ratio. */
const BADGE_HEIGHT = 64;

/**
 * Directories that list AcruxCore. Add one once its listing is live, or earlier
 * when the directory only publishes the listing after its crawler finds the badge
 * (AI Agents Directory and Good AI Tools work that way).
 */
const BADGES: DirectoryBadge[] = [
  {
    name: 'Neura Market',
    href: 'https://www.neura.market/directories/ai-tools',
    imgSrc: 'https://ykpiumpcqlgqzgslxicn.supabase.co/storage/v1/object/public/brand-assets/featured-badge.png',
    alt: 'Featured on Neura Market',
    title: 'Featured on Neura Market — the AI tools & companies directory',
    dataAttrs: { 'data-neura-market-badge': 'tool' },
    width: 240,
    height: 80,
  },
  {
    name: 'SaaSHub',
    href: 'https://www.saashub.com/acrux-core?utm_source=badge&utm_campaign=badge&utm_content=acrux-core&badge_variant=color&badge_kind=approved',
    imgSrc: 'https://cdn-b.saashub.com/img/badges/approved-color.png?v=1',
    alt: 'Acrux Core badge',
    width: 240,
    height: 80,
  },
  {
    name: 'AI Agents Directory',
    href: 'https://aiagentsdirectory.com/agent/acruxcore',
    imgSrc: 'https://aiagentsdirectory.com/featured-badge.svg?v=2024',
    alt: 'AcruxCore - Featured on AI Agents Directory',
    title: 'Discover AcruxCore on AI Agents Directory',
    width: 200,
    height: 50,
  },
  {
    name: 'Good AI Tools',
    href: 'https://goodaitools.com/ai/acruxcore',
    imgSrc: 'https://goodaitools.com/assets/images/badge-dark.png',
    alt: 'Good AI Tools',
    width: 207,
    height: 54,
  },
];

/**
 * Public "Press" page showing the directories that list AcruxCore. It lives at
 * `/press` because directory crawlers look for their badge on the homepage and a
 * fixed set of paths (`/about`, `/partners`, `/press`, `/contact`), and it is
 * prerendered so a crawler that runs no JavaScript still sees the badge.
 *
 * @returns The rendered Press page.
 */
export function PressPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Press"
        docTitle="Press — AcruxCore"
        title="Featured on."
        lead="Directories and catalogs where AcruxCore is listed."
      />
      <ul
        style={cssToStyle(
          'list-style:none;margin:0 0 clamp(40px,6vw,64px);padding:0;display:flex;flex-wrap:wrap;align-items:center;gap:16px;',
        )}
      >
        {BADGES.map((b) => (
          <li key={b.name}>
            <a
              href={b.href}
              title={b.title}
              target="_blank"
              rel="noopener"
              {...b.dataAttrs}
              style={cssToStyle('display:block;line-height:0;')}
            >
              <img
                src={b.imgSrc}
                alt={b.alt}
                width={Math.round((b.width * BADGE_HEIGHT) / b.height)}
                height={BADGE_HEIGHT}
                loading="lazy"
                style={cssToStyle('max-width:100%;height:auto;border-radius:8px;')}
              />
            </a>
          </li>
        ))}
      </ul>
    </MarketingShell>
  );
}
