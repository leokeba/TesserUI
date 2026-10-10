// visibleWhen / enabledWhen (DESIGN.md §5.3): "<path>=<value>" or
// "<path>!=<value>", several joined with "&", all of which must hold.

import { stringify } from '../client/json';
import { joinPath, segments } from './schema';

export interface Condition {
  path: string; // absolute
  equal: boolean;
  literal: string;
}

// `base` is the node's parent object; relative paths start there. Absolute
// paths are within the node's tree, whose root is `root` (a peer behind a
// gateway lives at /peers/<name>).
export function parseConditions(text: string, base: string, root = '/'): Condition[] {
  const out: Condition[] = [];
  for (const part of text.split('&')) {
    const m = /^\s*([^!=\s]+)\s*(!?=)\s*(.*?)\s*$/.exec(part);
    if (!m) continue;
    out.push({ path: resolvePath(m[1], base, root), equal: m[2] === '=', literal: m[3] });
  }
  return out;
}

export function resolvePath(path: string, base: string, root = '/'): string {
  const out = segments(path.startsWith('/') ? root : base);
  for (const s of segments(path)) {
    if (s === '..') out.pop();
    else if (s !== '.') out.push(s);
  }
  return out.reduce(joinPath, '/');
}

// Compares the value's JSON text with the literal; strings also match
// unquoted ("mode=manual"). A value that isn't in the store fails.
export function holds(conds: Condition[], get: (path: string) => unknown): boolean {
  for (const c of conds) {
    const v = get(c.path);
    if (v === undefined) return false;
    const json = stringify(v);
    const match = json === c.literal || (typeof v === 'string' && v === c.literal);
    if (match !== c.equal) return false;
  }
  return true;
}
