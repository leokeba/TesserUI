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
  // (/peers) lists its objects, lists and nodes as sub-entries, one level
  // deep, gathered by ui.group too.
  const kids = Object.entries(s.children ?? {}).filter(([, c]) => isEntry(c) || (c.type === 'list' && shown(c)));
  if (!sub && kids.length && (s.ui?.page === true || kids.some(([, c]) => c.type === 'remote'))) {
    e.children = [];
    for (const [n, c] of kids) gather(e.children, entry(n, joinPath(path, n), c, true), str(c, 'group'));
  }
  return e;
}

// ui.group gathers entries under a heading, where the first of them would be.
function gather(out: MenuEntry[], e: MenuEntry, group: string | undefined) {
  const g = group && out.find((h) => !h.href && h.label === group);
  if (!group) out.push(e);
  else if (g) g.children!.push(e);
  else out.push({ label: group, children: [e] });
}

// Values, lists and actions directly under the page, shown on its overview.
export function hasOwnItems(s: Schema): boolean {
  return Object.values(s.children ?? {}).some((c) => !isEntry(c) && shown(c) && c.type !== 'custom');
}

// A view's route: #/v/<id> for the node's, #<node>/_ui/<id> for a remote
// node's (DESIGN.md §6.5).
export const viewHref = (node: string, id: string) => (node === '/' ? `#/v/${id}` : `#${node}/_ui/${id}`);

export function buildMenu(s: Schema, home: string, views: ViewPage[] | null, t: (text: string) => string = (x) => x): MenuEntry[] {
  const out: MenuEntry[] = (views ?? []).map((v) => (v.icon ? { label: v.label, icon: v.icon, href: viewHref(home, v.id) } : { label: v.label, href: viewHref(home, v.id) }));
  if (hasOwnItems(s)) out.push({ label: t('Status'), icon: 'home', href: `#${home}` });
  for (const [name, c] of Object.entries(s.children ?? {})) if (isEntry(c)) gather(out, entry(name, joinPath(home, name), c, false), str(c, 'group'));
  return out;
}
