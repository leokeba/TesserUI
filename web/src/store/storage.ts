// What the page keeps in localStorage: tokens, preferences and the schema
// cache, none of which it can't do without (private mode, a full quota).

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// The schema cache's entries (DESIGN.md §7.2): at the quota, they give way
// to anything else, a token above all.
export const CACHE = 'tesserui:schema:';

export function storageSet(key: string, value: string | null, again = !key.startsWith(CACHE)) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode, full: the cache is only a cache
    if (!again) return;
    for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE)) localStorage.removeItem(k);
    storageSet(key, value, false);
  }
}
