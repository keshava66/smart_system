import { useCallback, useSyncExternalStore } from 'react';

// Shared breakpoints, matching Tailwind's lg and xl.
export const NARROW = '(max-width: 1023.98px)';
export const WIDE = '(min-width: 1280px)';

export function useMediaQuery(query) {
  const subscribe = useCallback((notify) => {
    const mql = window.matchMedia(query);
    mql.addEventListener('change', notify);
    return () => mql.removeEventListener('change', notify);
  }, [query]);
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}
