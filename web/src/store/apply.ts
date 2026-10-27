// Apply to all (DESIGN.md §6.6): the user's writes on one node go to every
// other node (tab) at the same path below its root, and in a launcher's
// workspace to the other connections' nodes too; each node's result shows
// on its tab.

import { isObject } from '../client/json';
import { errorText } from '../client/types';
import { joinPath } from '../model/schema';
import type { Session } from './session.svelte';

// A node's part in the last "apply to all".
export interface Applied {
  state: 'done' | 'absent' | 'offline' | 'refused';
  text?: string;
}

// Writes `rel`, a path below a node's root, on each node of the session
// but `except`, all at once; a gateway queues what's beyond its pending
// slots (ask()). Offline nodes aren't sent to.
export async function applyHere(s: Session, rel: string, body: unknown, except?: string): Promise<[string, Applied][]> {
  const nodes = s.tabs().filter((n) => n !== except);
  return Promise.all(
    nodes.map(async (n): Promise<[string, Applied]> => {
      const path = n === '/' ? rel : n + (rel === '/' ? '' : rel);
      let a: Applied = { state: 'offline' };
      if (!s.isOffline(path)) {
        const r = await s.ask({ op: 'set', path, body });
        a = r.status === 'ok' ? { state: 'done' } : r.status === 'not_found' ? { state: 'absent' } : { state: 'refused', text: errorText(r, s.store.t) };
      }
      s.applied[n] = a;
      return [s.nodeLabel(n), a];
    }),
  );
}

// Each session's last burst of writes.
const bursts = new WeakMap<Session, number>();

// A write made on `path`: what of it is shared goes to the other nodes.
// After the last of a burst of writes (a drag) settles, one toast tells
// which nodes didn't take it; the tabs show every node's result.
export async function applyWrite(s: Session, path: string, written: unknown) {
  const body = shared(s, path, written);
  if (body === undefined) return;
  const at = (bursts.get(s) ?? 0) + 1;
  bursts.set(s, at);
  const from = s.nodeRoot(path);
  const rel = from === '/' ? path : path.slice(from.length) || '/';
  const results = (await Promise.all([applyHere(s, rel, body, from), ...(s.others?.(rel, body) ?? [])])).flat();
  await new Promise((done) => setTimeout(done, 500));
  const failed = results.filter(([, a]) => a.state === 'refused' || a.state === 'offline');
  if (at !== bursts.get(s) || !failed.length) return;
  const done = results.filter(([, a]) => a.state === 'done').length;
  const text = [s.t('Applied to {n} of {total} other nodes', { n: done, total: results.length }), ...failed.map(([label, a]) => `${label}: ${a.text ?? s.t('offline')}`)];
  s.store.toasts.show(text.join('. '), 'warn', path);
}

// What of a write goes to the other nodes: not a node's own values
// (ui.perNode, ui.nodeName), even inside a form's patch. Undefined when
// nothing is left.
function shared(s: Session, path: string, body: unknown): unknown {
  const at = s.schemaAt(path);
  if (at?.ui?.perNode || at?.ui?.nodeName) return undefined;
  if (at?.type !== 'object' || !isObject(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    const c = shared(s, joinPath(path, k), v);
    if (c !== undefined) out[k] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

// Whether a write renames a node: it reaches a value with ui.nodeName.
export function renames(s: Session, path: string, body: unknown): boolean {
  const at = s.schemaAt(path);
  return !!at?.ui?.nodeName || (at?.type === 'object' && isObject(body) && Object.keys(body).some((k) => renames(s, joinPath(path, k), body[k])));
}
