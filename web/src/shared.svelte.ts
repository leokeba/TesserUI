// Shared by every component: the session, set once by main.ts.
import type { Session } from './store/session.svelte';

export const app = { session: null as unknown as Session };

// A form's local edits (DESIGN.md §7.4, ui.form), provided to its rows.
export class Draft {
  values: Record<string, unknown> = $state({});
  get size() {
    return Object.keys(this.values).length;
  }
}

export const DRAFT = Symbol('draft');

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}
