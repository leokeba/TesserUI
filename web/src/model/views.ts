// Views (DESIGN.md §8): explicit pages served at /_ui, combining values
// from anywhere in the tree, peers included.

import { buildLeaf, buildSection, depthOf, isElement, type Item, type Leaf } from './model';
import { joinPath, parentPath, remoteOf, schemaAt, segments, type Hint, type Schema } from './schema';
import { commonAncestor, type SubSpec } from '../store/subs';

export interface ViewItemDoc {
  node?: string;
  widget?: string;
  path?: string;
  label?: string;
  row?: ViewItemDoc[];
  card?: string;
  items?: ViewItemDoc[];
  text?: string;
  each?: string;
  item?: ViewItemDoc;
  [hint: string]: unknown;
}

export interface ViewPage {
  id: string;
  label: string;
  items: ViewItemDoc[];
}

export type ViewItem =
  | { kind: 'node'; path: string; item: Item | null }
  | { kind: 'row'; items: ViewItem[] }
  | { kind: 'card'; label: string; items: ViewItem[] }
  | { kind: 'text'; text: string };

export interface View {
  items: ViewItem[];
  // Schemas to fetch before the view is complete (paths, and objects whose
  // children an `each` needs).
  missing: string[];
  specs: SubSpec[];
}

const STRUCTURE = new Set(['node', 'widget', 'path', 'label', 'row', 'card', 'items', 'text', 'each', 'item']);
const SCHEMA_KEYS = new Set(['label', 'unit', 'step', 'min', 'max', 'description']);

// Extra keys of a view item override the schema's hints.
function withHints(s: Schema, doc: ViewItemDoc): Schema {
  const out: Schema = { ...s, ui: { ...s.ui } };
  for (const [k, v] of Object.entries(doc)) {
    if (STRUCTURE.has(k) && k !== 'label') continue;
    if (SCHEMA_KEYS.has(k)) (out as unknown as Record<string, unknown>)[k] = v;
    else out.ui![k] = v as Hint;
  }
  if (doc.widget) out.ui!.widget = doc.widget;
  return out;
}

function substitute(doc: ViewItemDoc, at: string): ViewItemDoc {
  const sub = (p: unknown) => (typeof p === 'string' ? p.replace(/^\$/, at) : p);
  const out: ViewItemDoc = { ...doc };
  for (const k of ['node', 'path', 'each'] as const) if (out[k] !== undefined) out[k] = sub(out[k]) as string;
  if (out.row) out.row = out.row.map((d) => substitute(d, at));
  if (out.items) out.items = out.items.map((d) => substitute(d, at));
  if (out.item) out.item = substitute(out.item, at);
  return out;
}

export function buildView(page: ViewPage, root: Schema): View {
  const missing: string[] = [];
  const watched: { path: string; depth: number }[] = [];

  const resolved = (path: string): Schema | undefined => {
    const s = schemaAt(root, path);
    const tree = s?.type === 'remote' ? s.tree : s;
    if (!s || (tree?.type === 'object' && !tree.children) || (s.type === 'remote' && !tree)) {
      missing.push(path);
      return undefined;
    }
    return tree;
  };

  const leafOrSection = (path: string, doc: ViewItemDoc, level: number, label?: string): ViewItem => {
    const s = resolved(path);
    if (!s) return { kind: 'node', path, item: null };
    const hinted = withHints(s, label && !doc.label ? { ...doc, label } : doc);
    const nodeRoot = remoteOf(root, path)?.path ?? '/';
    watched.push({ path, depth: depthOf(hinted) });
    // A custom element over an object draws it whole: a custom page when
    // it is a view's only item (DESIGN.md §9.8).
    if (hinted.type === 'object' && !isElement(hinted.ui?.widget)) {
      return { kind: 'node', path, item: buildSection(path, hinted, level, nodeRoot) };
    }
    const leaf: Leaf = buildLeaf(path.slice(path.lastIndexOf('/') + 1), path, hinted, parentPath(path), nodeRoot);
    return { kind: 'node', path, item: leaf };
  };

  const build = (doc: ViewItemDoc, level: number, label?: string): ViewItem[] => {
    if (doc.text !== undefined) return [{ kind: 'text', text: doc.text }];
    if (doc.row) return [{ kind: 'row', items: doc.row.flatMap((d) => build(d, level + 1)) }];
    if (doc.card !== undefined) {
      const docs = doc.items ?? [];
      // A card around one subtree is that subtree's card, under the card's label.
      if (docs.length === 1 && (docs[0].node ?? docs[0].path) !== undefined && !docs[0].each) {
        const [only] = build(docs[0], 1);
        if (only?.kind === 'node' && only.item?.kind === 'section') return [{ ...only, item: { ...only.item, label: doc.card || only.item.label } }];
        return [{ kind: 'card', label: doc.card, items: only ? [only] : [] }];
      }
      return [{ kind: 'card', label: doc.card, items: docs.flatMap((d) => build(d, 2)) }];
    }
    if (doc.each !== undefined && doc.item) {
      const parent = resolved(doc.each);
      if (!parent) return [];
      return Object.entries(parent.children ?? {}).flatMap(([name, c]) =>
        build(substitute(doc.item!, joinPath(doc.each!, name)), level, c.tree?.label ?? c.label ?? name),
      );
    }
    const path = doc.node ?? doc.path;
    if (path === undefined) return [];
    return [leafOrSection(path, doc, level, label)];
  };

  const items = page.items.flatMap((d) => build(d, 1));

  // One subscription per node involved (the host, each peer), at the
  // deepest path covering what the view shows of it (DESIGN.md §8).
  const groups = new Map<string, { path: string; depth: number }[]>();
  for (const w of watched) {
    const node = remoteOf(root, w.path)?.path ?? '/';
    if (!groups.has(node)) groups.set(node, []);
    groups.get(node)!.push(w);
  }
  const specs: SubSpec[] = [];
  for (const list of groups.values()) {
    const base = commonAncestor(list.map((w) => w.path));
    const depth = Math.max(...list.map((w) => segments(w.path).length - segments(base).length + w.depth));
    specs.push({ path: base, depth: Number.isFinite(depth) ? depth : undefined });
  }
  return { items, missing, specs };
}

// Items of a view as model items, for show(): sections and leaves.
export function viewModelItems(items: ViewItem[]): Item[] {
  const out: Item[] = [];
  for (const i of items) {
    if (i.kind === 'node' && i.item) out.push(i.item);
    else if (i.kind === 'row' || i.kind === 'card') out.push(...viewModelItems(i.items));
  }
  return out;
}
