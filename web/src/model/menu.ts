// The navigation menu (DESIGN.md §6.3): the view pages, the node's own values
// (its status), then one entry per child object or remote node of the page
// the UI starts from, in tree order. Each entry is a page of its own.

import type { Schema } from './schema';
import { joinPath } from './schema';
import { humanize } from './format';
import type { ViewPage } from './views';

export interface MenuEntry {
  label: string;
  icon?: string;
  // The route ("#/v/<id>", "#/<path>"); a ui.group heading has none.
  href?: string;
  // A remote node's state.
  online?: boolean;
  children?: MenuEntry[];
}

const str = (s: Schema, key: string) => (typeof s.ui?.[key] === 'string' ? (s.ui[key] as string) : undefined);
const shown = (s: Schema) => s.ui?.hidden !== true;
// What becomes an entry rather than a card: objects and remote nodes.
export const isEntry = (s: Schema) => (s.type === 'object' || s.type === 'remote') && shown(s);

function entry(name: string, path: string, s: Schema, sub: boolean): MenuEntry {
  const e: MenuEntry = { label: s.label ?? (s.type === 'remote' ? (s.tree?.label ?? name) : humanize(name)), href: `#${path}` };
  const icon = str(s, 'icon');
  if (icon) e.icon = icon;
  if (s.type === 'remote') e.online = s.online !== false;
  // An object that is a page of its own (/sys) or holds remote nodes
  // (/peers) lists its objects and nodes as sub-entries, one level deep.
  const kids = Object.entries(s.children ?? {}).filter(([, c]) => isEntry(c));
  if (!sub && kids.length && (s.ui?.page === true || kids.some(([, c]) => c.type === 'remote'))) {
    e.children = kids.map(([n, c]) => entry(n, joinPath(path, n), c, true));
  }
  return e;
}

// Values, lists and actions directly under the page, shown on its overview.
export function hasOwnItems(s: Schema): boolean {
  return Object.values(s.children ?? {}).some((c) => !isEntry(c) && shown(c) && c.type !== 'custom');
}

export function buildMenu(s: Schema, home: string, views: ViewPage[] | null, t: (text: string) => string = (x) => x): MenuEntry[] {
  const out: MenuEntry[] = (views ?? []).map((v) => ({ label: v.label, href: `#/v/${v.id}` }));
  if (hasOwnItems(s)) out.push({ label: t('Status'), icon: 'home', href: `#${home}` });
  // ui.group gathers entries under a heading, where its first one would be.
  const groups = new Map<string, MenuEntry>();
  for (const [name, c] of Object.entries(s.children ?? {})) {
    if (!isEntry(c)) continue;
    const e = entry(name, joinPath(home, name), c, false);
    const group = str(c, 'group');
    if (!group) {
      out.push(e);
      continue;
    }
    let g = groups.get(group);
    if (!g) {
      groups.set(group, (g = { label: group, children: [] }));
      out.push(g);
    }
    g.children!.push(e);
  }
  return out;
}
