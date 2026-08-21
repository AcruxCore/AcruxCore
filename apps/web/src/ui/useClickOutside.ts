import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Calls `onOutside` on any pointerdown outside `ref`'s element — used by
 * {@link MultiSelect}'s popover, which (unlike {@link Dialog}/{@link Drawer})
 * isn't built on a Radix primitive that already handles this.
 *
 * @param ref - The element the click must land outside of to fire.
 * @param onOutside - Called once per qualifying outside click.
 */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void): void {
  useEffect(() => {
    function handler(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [ref, onOutside]);
}
