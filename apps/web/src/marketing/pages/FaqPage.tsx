import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { MarketingShell, ContentHeader } from '../MarketingShell';
import { cssToStyle, DOCS_URL, Eyebrow } from '../marketing-chrome';
import { FAQ_GROUPS, FaqAnswer } from '../faq';

/**
 * Public FAQ page: the questions someone asks while deciding whether to use
 * AcruxCore, including the ones where the answer is "use something else".
 *
 * Linked from the footer's Product column and from `/compare`. The `FAQPage`
 * JSON-LD that goes with it is injected per-route by `scripts/prerender.mjs`
 * rather than living in this component, because the shared `index.html` head is
 * copied verbatim into every marketing page — a block written here would either
 * be dropped by the prerenderer or, worse, claim that all fourteen pages are
 * FAQs.
 *
 * @returns The rendered FAQ page.
 */
export function FaqPage(): ReactNode {
  return (
    <MarketingShell>
      <ContentHeader
        eyebrow="Questions"
        title="Frequently asked questions"
        lead="What AcruxCore does, how it compares to the alternatives, and where it is the wrong tool for the job. Every answer that could be argued with links to the evidence behind it."
        docTitle="FAQ — AcruxCore"
      />

      {/* Jump links: the page is long enough that the comparison group — the
          reason most people arrive — would otherwise be below the fold. */}
      <nav
        aria-label="Jump to a section"
        style={cssToStyle('display:flex;flex-wrap:wrap;gap:8px;margin:0 0 clamp(32px,5vw,48px);')}
      >
        {FAQ_GROUPS.map((group) => (
          <a
            key={group.id}
            href={`#${group.id}`}
            style={cssToStyle(
              'font-size:13px;font-weight:550;padding:7px 13px;border:1px solid var(--line-soft);border-radius:999px;text-decoration:none;color:var(--ink-soft);',
            )}
          >
            {group.title}
          </a>
        ))}
      </nav>

      {FAQ_GROUPS.map((group) => (
        <section
          key={group.id}
          id={group.id}
          style={cssToStyle('margin-bottom:clamp(36px,5vw,56px);scroll-margin-top:88px;')}
        >
          <Eyebrow>{group.title}</Eyebrow>
          <div className="acx-prose" style={cssToStyle('margin-top:14px;')}>
            {group.items.map((item) => (
              <div
                key={item.question}
                style={cssToStyle('padding:20px 0;border-bottom:1px solid var(--line-soft);')}
              >
                <h2
                  style={cssToStyle(
                    'font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 10px;line-height:1.35;',
                  )}
                >
                  {item.question}
                </h2>
                {/* FaqAnswer emits its own <p> per paragraph; a wrapper here
                    would nest <p> inside <p>, which the parser silently splits. */}
                <FaqAnswer answer={item.answer} />
              </div>
            ))}
          </div>
        </section>
      ))}

      <section
        style={cssToStyle(
          'margin:0 0 clamp(48px,7vw,80px);padding:22px 24px;border:1px solid var(--line-soft);border-radius:14px;',
        )}
      >
        <h2 style={cssToStyle('font-size:17px;font-weight:650;letter-spacing:-.01em;margin:0 0 8px;')}>
          Something not answered here?
        </h2>
        <p className="acx-prose" style={cssToStyle('margin:0;')}>
          The <Link to="/compare">comparison matrix</Link> has the row-by-row detail with a source
          for every fact, the{' '}
          <a href={`${DOCS_URL}/blog/hands-on-llm-ops-comparison`} target="_blank" rel="noreferrer">
            hands-on test of nine platforms
          </a>{' '}
          is the long version, and <Link to="/contact">contact</Link> reaches a person.
        </p>
      </section>
    </MarketingShell>
  );
}
