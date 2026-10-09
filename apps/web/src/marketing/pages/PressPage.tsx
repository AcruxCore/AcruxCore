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
}

/**
 * Directories that list AcruxCore. Add one only once its listing is live. Every
 * badge image is 3:1, so they share one rendered size.
 */
const BADGES: DirectoryBadge[] = [
  {
    name: 'Neura Market',
    href: 'https://www.neura.market/directories/ai-tools',
    imgSrc: 'https://ykpiumpcqlgqzgslxicn.supabase.co/storage/v1/object/public/brand-assets/featured-badge.png',
    alt: 'Featured on Neura Market',
    title: 'Featured on Neura Market — the AI tools & companies directory',
    dataAttrs: { 'data-neura-market-badge': 'tool' },
  },
  {
    name: 'SaaSHub',
    href: 'https://www.saashub.com/acrux-core?utm_source=badge&utm_campaign=badge&utm_content=acrux-core&badge_variant=color&badge_kind=approved',
    imgSrc: 'https://cdn-b.saashub.com/img/badges/approved-color.png?v=1',
    alt: 'Acrux Core badge',
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
          'list-style:none;margin:0 0 clamp(40px,6vw,64px);padding:0;display:flex;flex-wrap:wrap;gap:16px;',
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
                width={240}
                height={80}
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
