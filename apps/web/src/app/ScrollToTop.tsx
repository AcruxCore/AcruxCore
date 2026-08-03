import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Resets scroll position on client-side navigation.
 *
 * React Router does not touch the scroll offset when the route changes, so
 * following a link from the footer swapped the page underneath the visitor while
 * they stayed pinned at the bottom — the new page looked identical (same footer)
 * until they scrolled up, which read as "the link did nothing".
 *
 * Three cases, in order:
 *
 * - **Back / forward** (`POP`): do nothing. The browser restores the previous
 *   offset itself, and overriding it would break the one navigation where keeping
 *   your place is the whole point.
 * - **A link with a hash** (e.g. `/sdk#python`): scroll that element into view.
 *   Targets carry `scroll-margin-top` so the sticky header does not cover them.
 * - **Everything else**: jump to the top.
 *
 * Rendered once inside the router, above the route table.
 *
 * @returns Nothing — this component only produces the scroll side effect.
 */
export function ScrollToTop(): null {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();

  useEffect(() => {
    if (navigationType === 'POP') return;

    if (hash) {
      const target = document.getElementById(hash.slice(1));
      if (target) {
        target.scrollIntoView({ block: 'start' });
        return;
      }
    }

    window.scrollTo(0, 0);
  }, [pathname, hash, navigationType]);

  return null;
}
