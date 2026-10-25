// Shared by every component of one UI: its session, through Svelte context,
// so that several UIs can live on one page (DESIGN.md §9.9).
import { getContext, setContext } from 'svelte';
import type { Session } from './store/session.svelte';

const SESSION = Symbol('tesserui');

export function provideSession(s: Session) {
  setContext(SESSION, s);
}

export function useSession(): Session {
  return getContext(SESSION);
}

// A form's local edits (DESIGN.md §7.4, ui.form), provided to its rows.
export class Draft {
  values: Record<string, unknown> = $state({});
  get size() {
    return Object.keys(this.values).length;
  }
}

export const DRAFT = Symbol('draft');
// What conditions read (DESIGN.md §5.3): in a form, its draft first.
export const reader = (store: { get(p: string): unknown }, draft?: Draft | null) => (p: string) =>
  draft && p in draft.values ? draft.values[p] : store.get(p);
// Whether a section's content is shown (no closed group above it): a
// function, for keep-alives (DESIGN.md §7.4).
export const SHOWN = Symbol('shown');

// A files widget's place in its tree (DESIGN.md §4.1): the route's part
// after a "~" segment (#/sys/files/~/www/index.html), and how to go
// elsewhere.
export interface Place {
  readonly sub?: string;
  go(href: string): void;
}
export const PLACE = Symbol('place');

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
