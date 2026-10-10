// TesserAPI's schema view (TesserAPI DESIGN.md §7, §7.1, §14.1).

export type SchemaType =
  | 'object'
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'action'
  | 'event'
  | 'custom'
  | 'list'
  | 'array'
  | 'file'
  | 'remote';

// Access levels (TesserAPI §13.1), ordered.
export type Level = 'public' | 'user' | 'admin';
export const rank = (l: Level | null | undefined) => (l === 'admin' ? 2 : l === 'user' ? 1 : 0);
export const higher = (a: Level | undefined, b: Level | undefined): Level | undefined => (rank(b) > rank(a) ? b : a);

export type Hint = string | number | boolean;

export interface Schema {
  type: SchemaType;
  writable?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  enum?: string[];
  arg?: string;
  // Actions taking an object: its fields' schema.
  params?: Schema;
  returns?: string;
  deferred?: boolean;
  // Never read back (passwords).
  secret?: boolean;
  // The level writing this node takes (its own; inherited by its subtree).
  access?: Level;
  persist?: boolean;
  description?: string;
  label?: string;
  unit?: string;
  step?: number;
  ui?: Record<string, Hint>;
  // Objects: absent when the fetch's depth stopped above them.
  children?: Record<string, Schema>;
  // Lists and arrays
  maxSize?: number;
  items?: Schema;
  // Keyed lists: the element field that names it.
  key?: string;
  // Arrays of a fixed length.
  fixed?: boolean;
  // Files
  readable?: boolean;
  contentType?: string;
  accept?: string; // the upload's file chooser filter (".bin")
  // Remote stubs
  mirror?: boolean;
  online?: boolean;
  schema?: string;
  // Renderer-side: the remote node's own tree, once fetched through it.
  tree?: Schema;
}

export function joinPath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export function isUnder(path: string, base: string): boolean {
  return base === '/' || path === base || path.startsWith(base + '/');
}

// The schema at `path` in a tree of fetched schemas, crossing remote nodes
// through their fetched trees.
export function schemaAt(root: Schema, path: string): Schema | undefined {
  let s: Schema | undefined = root;
  for (const name of segments(path)) {
    if (s?.type === 'remote') s = s.tree;
    s = s?.children?.[name];
    if (!s) return undefined;
  }
  return s;
}

// The level writing the node at `path` takes: the highest of its own and
// its ancestors' (TesserAPI §13.1).
export function accessAt(root: Schema, path: string): Level | undefined {
  let s: Schema | undefined = root;
  let need = root.access;
  for (const name of segments(path)) {
    if (s?.type === 'remote') s = s.tree;
    s = s?.children?.[name];
    if (!s) break;
    need = higher(need, s.access);
  }
  return need;
}

// Merges a fetched schema into the tree at `path`. Deeper fetches add
// children; a shallower one doesn't erase what is already known below.
export function mergeSchema(root: Schema, path: string, fetched: Schema): Schema {
  const names = segments(path);
  if (!names.length) {
    // The root is shared: update it in place.
    const merged = mergeNode(root, fetched);
    for (const k of Object.keys(root)) delete (root as unknown as Record<string, unknown>)[k];
    return Object.assign(root, merged);
  }
  let parent: Schema = root;
  for (let i = 0; i < names.length - 1; i++) {
    const host: Schema = parent.type === 'remote' ? (parent.tree ??= { type: 'object' }) : parent;
    const next: Schema | undefined = host.children?.[names[i]];
    if (!next) return root;
    parent = next;
  }
  const host: Schema = parent.type === 'remote' ? (parent.tree ??= { type: 'object' }) : parent;
  host.children ??= {};
  const name = names[names.length - 1];
  const old = host.children[name];
  if (old?.type === 'remote' && fetched.type !== 'remote') {
    old.tree = old.tree ? mergeNode(old.tree, fetched) : fetched;
  } else {
    host.children[name] = old ? mergeNode(old, fetched) : fetched;
  }
  return root;
}

function mergeNode(old: Schema, fresh: Schema): Schema {
  if (old.type !== fresh.type) return fresh;
  const out: Schema = { ...fresh };
  if (old.type === 'remote') {
    // A new advertised hash means the peer's tree changed.
    if (old.tree && old.schema === fresh.schema) out.tree = old.tree;
    return out;
  }
  if (old.children) {
    if (!fresh.children) {
      out.children = old.children;
    } else {
      // A fetch narrowed with `keys` returns some children only. Trees don't
      // lose nodes, so keep the others, in declaration order; new ones
      // (peers mounted since) come last.
      out.children = {};
      for (const [k, v] of Object.entries(old.children)) {
        out.children[k] = fresh.children[k] ? mergeNode(v, fresh.children[k]) : v;
      }
      for (const [k, v] of Object.entries(fresh.children)) if (!(k in out.children)) out.children[k] = v;
    }
  }
  return out;
}

// The innermost remote node on the way to `path`, if any.
export function remoteOf(root: Schema, path: string): { path: string; stub: Schema } | undefined {
  let s: Schema | undefined = root;
  let at = '/';
  let found: { path: string; stub: Schema } | undefined;
  for (const name of segments(path)) {
    if (s?.type === 'remote') s = s.tree;
    s = s?.children?.[name];
    at = joinPath(at, name);
    if (!s) break;
    if (s.type === 'remote') found = { path: at, stub: s };
  }
  return found;
}
