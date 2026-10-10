// Schema → UI model: widget inference (DESIGN.md §4), hints (§5) and layout
// (§6.1). Pure functions, shared by every page and view.

import { parseConditions, type Condition } from './conditions';
import { decimalsOf, humanize } from './format';
import { isUnder, joinPath, parentPath, type Hint, type Schema } from './schema';

export type Widget =
  | 'toggle'
  | 'checkbox'
  | 'led'
  | 'slider'
  | 'knob'
  | 'number'
  | 'stepper'
  | 'readout'
  | 'bar'
  | 'gauge'
  | 'chart'
  | 'segmented'
  | 'select'
  | 'radio'
  | 'text'
  | 'password'
  | 'textarea'
  | 'color'
  | 'button'
  | 'hold'
  | 'json'
  | 'events'
  | 'table'
  | 'link'
  // A custom element (DESIGN.md §9.8): any name with a hyphen.
  | `${string}-${string}`;

// Custom element names: lowercase, starting with a letter, with a hyphen
// (the HTML rule).
export const isElement = (w: unknown): w is `${string}-${string}` =>
  typeof w === 'string' && /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/.test(w);

export interface Option {
  value: string;
  label: string;
}

interface Base {
  name: string;
  path: string;
  label: string;
  description?: string;
  icon?: string;
  advanced: boolean;
  hidden: boolean;
  visibleWhen?: Condition[];
  enabledWhen?: Condition[];
}

export interface Leaf extends Base {
  kind: 'leaf';
  widget: Widget;
  schema: Schema;
  // The value's type; for an action, its argument's type ('' without one).
  type: string;
  // The control edits the value (or the action's argument).
  editable: boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  precision?: number;
  format?: string;
  placeholder?: string;
  maxLength?: number;
  options?: Option[];
  confirm?: string;
  // Actions
  field?: Widget; // the argument's input, for typed actions
  value?: Hint; // the argument a `button` sends
  returns?: string;
  deferred?: boolean;
  style?: string;
  submit?: boolean;
  // Custom elements: the module script that defines it.
  script?: string;
  // Charts, events, tables
  history?: number;
  toast?: boolean;
  columns?: Leaf[];
  maxSize?: number;
}

export interface Section extends Base {
  kind: 'section';
  // 1: card, 2: sub-section, 3 and more: collapsible group.
  level: number;
  items: Item[];
  advancedItems: Item[];
  // The schema stopped above this object's children: fetch them on opening.
  lazy: boolean;
  tabs: boolean;
  inline: boolean;
  collapsed: boolean;
  form: boolean;
  columns?: number;
}

export interface LinkItem extends Base {
  kind: 'link';
  remote: boolean;
  online: boolean;
  schemaHash?: string;
}

export type Item = Leaf | Section | LinkItem;

export interface Page {
  path: string;
  label: string;
  description?: string;
  cards: Section[];
  columns: number;
  // Subscription parameters for the page (DESIGN.md §7.3).
  keys?: string;
  depth: number;
}

const ui = (s: Schema, key: string): Hint | undefined => s.ui?.[key];
const uiStr = (s: Schema, key: string) => (typeof s.ui?.[key] === 'string' ? (s.ui[key] as string) : undefined);
const uiNum = (s: Schema, key: string) => (typeof s.ui?.[key] === 'number' ? (s.ui[key] as number) : undefined);
const isNumeric = (t: string | undefined) => t === 'integer' || t === 'number';

// The widget for a value of type `type` (tier 0), overridden by `ui.widget`
// when it fits (tier 1). `editable` is false for read-only values.
export function inferWidget(s: Schema, type: string, editable: boolean): Widget {
  const hasRange = s.min !== undefined && s.max !== undefined;
  const hint = uiStr(s, 'widget');
  if (hint && fits(hint, s, type, editable, hasRange)) return hint as Widget;
  switch (type) {
    case 'boolean':
      return editable ? 'toggle' : 'led';
    case 'integer':
    case 'number':
      if (!editable) return 'readout';
      return hasRange ? 'slider' : 'number';
    case 'string':
      if (!editable) return 'readout';
      if (s.enum) {
        const labels = optionsOf(s) ?? [];
        return labels.length <= 4 && labels.every((o) => o.label.length <= 10) ? 'segmented' : 'select';
      }
      return 'text';
    default:
      return 'readout';
  }
}

function fits(w: string, s: Schema, type: string, editable: boolean, hasRange: boolean): boolean {
  switch (w) {
    case 'toggle':
    case 'checkbox':
      return type === 'boolean' && editable;
    case 'led':
      return type === 'boolean';
    case 'slider':
    case 'knob':
      return isNumeric(type) && editable && hasRange;
    case 'number':
    case 'stepper':
      return isNumeric(type) && editable;
    case 'readout':
      return true;
    case 'bar':
    case 'gauge':
      return isNumeric(type) && hasRange;
    case 'chart':
      return isNumeric(type);
    case 'select':
    case 'segmented':
    case 'radio':
      return type === 'string' && !!s.enum && editable;
    case 'text':
    case 'password':
    case 'textarea':
      return type === 'string' && !s.enum && editable;
    case 'color':
      return (type === 'string' || type === 'integer') && editable;
    default:
      return false;
  }
}

export function optionsOf(s: Schema): Option[] | undefined {
  if (!s.enum) return undefined;
  const labels = uiStr(s, 'labels')?.split(',');
  return s.enum.map((v, i) => ({ value: v, label: labels?.[i]?.trim() || v }));
}

// The root of the node being built: absolute condition paths are relative to
// it. Set by buildPage() and buildLeaf() for the duration of one build.
let nodeRoot = '/';

function base(name: string, path: string, s: Schema, parent: string): Base {
  const b: Base = {
    name,
    path,
    label: s.label ?? humanize(name),
    advanced: ui(s, 'advanced') === true,
    hidden: ui(s, 'hidden') === true,
  };
  if (s.description) b.description = s.description;
  const icon = uiStr(s, 'icon');
  if (icon) b.icon = icon;
  const vis = uiStr(s, 'visibleWhen');
  if (vis) b.visibleWhen = parseConditions(vis, parent, nodeRoot);
  const en = uiStr(s, 'enabledWhen');
  if (en) b.enabledWhen = parseConditions(en, parent, nodeRoot);
  return b;
}

export function buildLeaf(name: string, path: string, s: Schema, parent: string, root?: string): Leaf {
  if (root !== undefined) nodeRoot = root;
  const leaf: Leaf = { ...base(name, path, s, parent), kind: 'leaf', widget: 'readout', schema: s, type: s.type, editable: false };
  if (s.min !== undefined) leaf.min = s.min;
  if (s.max !== undefined) leaf.max = s.max;
  if (s.unit) leaf.unit = s.unit;
  const confirm = uiStr(s, 'confirm');
  if (confirm) leaf.confirm = confirm;
  const placeholder = uiStr(s, 'placeholder');
  if (placeholder) leaf.placeholder = placeholder;
  if (s.maxLength) leaf.maxLength = s.maxLength;

  // A custom element takes any node, objects included, as it is.
  if (isElement(s.ui?.widget)) {
    leaf.widget = s.ui.widget;
    leaf.editable = (!!s.writable || s.type === 'action' || s.type === 'list') && ui(s, 'readonly') !== true;
    const script = uiStr(s, 'script');
    if (script) leaf.script = script;
    if (s.type === 'action' && s.arg) leaf.type = s.arg;
    number(leaf, s);
    if (s.enum) leaf.options = optionsOf(s);
    return leaf;
  }
  switch (s.type) {
    case 'action':
      return action(leaf, s);
    case 'event':
      leaf.widget = 'events';
      leaf.toast = ui(s, 'toast') === true;
      return leaf;
    case 'list':
      leaf.widget = 'table';
      leaf.editable = true;
      leaf.maxSize = s.maxSize;
      leaf.columns = s.items ? columns(s.items, '') : [];
      return leaf;
    case 'custom':
      leaf.widget = 'json';
      leaf.editable = !!s.writable;
      return leaf;
    case 'remote':
      return leaf; // links are built by sections
  }
  leaf.editable = !!s.writable && ui(s, 'readonly') !== true;
  leaf.widget = inferWidget(s, s.type, leaf.editable);
  number(leaf, s);
  if (s.enum) leaf.options = optionsOf(s);
  if (leaf.widget === 'chart') leaf.history = uiNum(s, 'history') ?? 60;
  return leaf;
}

function number(leaf: Leaf, s: Schema) {
  if (!isNumeric(leaf.type)) return;
  leaf.step = s.step ?? (leaf.type === 'integer' ? 1 : undefined);
  leaf.precision = uiNum(s, 'precision') ?? decimalsOf(s.step) ?? (leaf.type === 'integer' ? 0 : undefined);
  const format = uiStr(s, 'format');
  if (format) leaf.format = format;
}

function action(leaf: Leaf, s: Schema): Leaf {
  leaf.deferred = !!s.deferred;
  if (s.returns) leaf.returns = s.returns;
  const style = uiStr(s, 'style');
  if (style) leaf.style = style;
  leaf.submit = ui(s, 'submit') === true;
  const arg = s.arg;
  const hint = uiStr(s, 'widget');
  leaf.widget = 'button';
  // Deferred actions take tesser::Call&, which the schema reports as an
  // untyped argument: they're buttons.
  if (!arg || s.deferred) return leaf;
  leaf.type = arg;
  if (hint === 'button' && ui(s, 'value') !== undefined) {
    leaf.value = ui(s, 'value');
    return leaf;
  }
  if (hint === 'hold' && arg === 'boolean') {
    leaf.widget = 'hold';
    return leaf;
  }
  if (arg === 'any') {
    // Raw JSON argument: only under "Advanced".
    leaf.field = 'json';
    leaf.advanced = true;
    return leaf;
  }
  leaf.editable = true;
  const argSchema: Schema = { type: arg as Schema['type'], writable: true, min: s.min, max: s.max, step: s.step, ui: s.ui };
  leaf.field = inferWidget({ ...argSchema, ui: { ...s.ui, widget: hint === 'button' ? '' : (hint ?? '') } }, arg, true);
  number(leaf, s);
  return leaf;
}

// The leaves of a list element, flattened: nested objects contribute their
// leaves with paths relative to the element.
function columns(items: Schema, prefix: string): Leaf[] {
  const out: Leaf[] = [];
  if (items.type !== 'object') return [buildLeaf('value', '', items, '')];
  for (const [name, c] of Object.entries(items.children ?? {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (c.type === 'object') out.push(...columns(c, rel));
    else if (c.type !== 'action' && c.type !== 'event' && ui(c, 'hidden') !== true) out.push(buildLeaf(name, rel, c, ''));
  }
  return out;
}

function link(name: string, path: string, s: Schema, parent: string): LinkItem {
  const l: LinkItem = { ...base(name, path, s, parent), kind: 'link', remote: s.type === 'remote', online: s.online !== false };
  if (s.type === 'remote') {
    if (!s.label) l.label = name;
    if (s.schema) l.schemaHash = s.schema;
    // A peer's label is in its own root schema, once fetched.
    if (s.tree?.label) l.label = s.tree.label;
    if (s.tree?.description) l.description = s.tree.description;
  }
  return l;
}

function section(name: string, path: string, s: Schema, level: number, parent: string, promoted: Section[]): Section {
  const sec: Section = {
    ...base(name, path, s, parent),
    kind: 'section',
    level,
    items: [],
    advancedItems: [],
    lazy: !s.children,
    tabs: ui(s, 'tabs') === true,
    inline: ui(s, 'inline') === true,
    collapsed: ui(s, 'collapsed') === true,
    form: ui(s, 'form') === true,
  };
  const cols = uiNum(s, 'columns');
  if (cols) sec.columns = cols;
  for (const [childName, c] of Object.entries(s.children ?? {})) {
    const childPath = joinPath(path, childName);
    let item: Item;
    if (c.type === 'object' && isElement(c.ui?.widget) && ui(c, 'page') !== true) {
      item = buildLeaf(childName, childPath, c, path);
    } else if (c.type === 'remote' || (c.type === 'object' && ui(c, 'page') === true)) {
      item = link(childName, childPath, c, path);
    } else if (c.type === 'object') {
      if (ui(c, 'card') === true && level >= 1) {
        // Nested below a card: its own card instead.
        promoted.push(section(childName, childPath, c, 1, path, promoted));
        continue;
      }
      item = section(childName, childPath, c, level + 1, path, promoted);
    } else {
      item = buildLeaf(childName, childPath, c, path);
    }
    (item.advanced ? sec.advancedItems : sec.items).push(item);
  }
  if (sec.form) {
    const actions = sec.items.filter((i): i is Leaf => i.kind === 'leaf' && i.schema.type === 'action');
    const submit = actions.find((a) => a.submit) ?? actions[0];
    if (submit) submit.submit = true;
  }
  return sec;
}

// The page at `path`, from the schema of the page's object. `root` is the
// path of the node it belongs to ('/', or a remote node's path).
export function buildPage(s: Schema, path: string, root = '/', t: (text: string) => string = (x) => x): Page {
  nodeRoot = root;
  const page: Page = {
    path,
    label: s.label ?? (path === '/' ? t('Device') : root === path ? path.slice(path.lastIndexOf('/') + 1) : humanize(path.slice(path.lastIndexOf('/') + 1))),
    cards: [],
    columns: uiNum(s, 'columns') ?? 3,
    depth: depthOf(s),
  };
  if (s.description) page.description = s.description;
  // A page drawn by a custom element: one card, the element.
  if (isElement(s.ui?.widget)) {
    const leaf = buildLeaf(path.slice(path.lastIndexOf('/') + 1) || 'root', path, s, parentPath(path), root);
    leaf.label = '';
    page.cards.push({ ...base('', path, {type: 'object'}, path), kind: 'section', level: 1, items: [leaf], advancedItems: [], lazy: false, tabs: false, inline: false, collapsed: false, form: false });
    return page;
  }
  // Values directly under the page form a first, untitled card; each child
  // object is a card (advanced ones start collapsed); remote nodes get a card
  // of their own.
  const promoted: Section[] = [];
  const top = section('', path, { ...s, ui: { ...s.ui, form: false, tabs: false, inline: false } }, 0, path, promoted);
  const first: Section = { ...top, level: 1, label: '', items: [], advancedItems: [] };
  const nodes: Section = { ...first, label: t('Nodes'), items: [], advancedItems: [] };
  for (const item of [...top.items, ...top.advancedItems]) {
    if (item.kind === 'section') {
      if (item.advanced) item.collapsed = true;
      // Cards promoted with ui.card follow the card they come from.
      page.cards.push(item, ...promoted.filter((p) => isUnder(p.path, item.path)));
    } else if (item.kind === 'link' && item.remote) {
      nodes.items.push(item);
    } else {
      (item.advanced ? first.advancedItems : first.items).push(item);
    }
  }
  // Hidden values are read (they're in the subscription), never shown: a card
  // of hidden values only would be empty.
  if ([...first.items, ...first.advancedItems].some((i) => !i.hidden)) page.cards.unshift(first);
  if (nodes.items.length) page.cards.push(nodes);

  // Subscribe to everything shown except mirrored remote nodes, whose copies
  // would come along, and sub-pages, which subscribe themselves.
  const children = Object.entries(s.children ?? {});
  const keep = children.filter(([, c]) => !(c.type === 'remote' && c.mirror) && !(c.type === 'object' && ui(c, 'page') === true));
  const valued = keep.filter(([, c]) => c.type !== 'action' && c.type !== 'event');
  if (valued.length < children.filter(([, c]) => c.type !== 'action' && c.type !== 'event').length) {
    page.keys = valued.map(([n]) => n).join(',');
  }
  return page;
}

// A subtree rendered as one section at `level` (a view's node item).
export function buildSection(path: string, s: Schema, level: number, root = '/'): Section {
  nodeRoot = root;
  const promoted: Section[] = [];
  const name = path.slice(path.lastIndexOf('/') + 1);
  const sec = section(name, path, s, level, parentPath(path), promoted);
  sec.items.push(...promoted.map((p) => ({ ...p, level: level + 1 })));
  return sec;
}

// Object levels below `s` that its schema expands (the `depth` that reads
// all of it).
export function depthOf(s: Schema): number {
  // A custom element may read anything below its object.
  if (s.type === 'object' && isElement(s.ui?.widget)) return Infinity;
  if (s.type !== 'object' || !s.children) return 0;
  let d = 0;
  for (const c of Object.values(s.children)) d = Math.max(d, depthOf(c));
  return d + 1;
}

// Paths that have a place on screen: errors and events for other paths go to
// the nearest of these above them (DESIGN.md §7.3, §7.4).
export function visiblePaths(page: { cards: Section[] }): Set<string> {
  const out = new Set<string>();
  const walk = (items: Item[]) => {
    for (const i of items) {
      if (i.hidden) continue;
      out.add(i.path);
      if (i.kind === 'section') walk([...i.items, ...i.advancedItems]);
    }
  };
  walk(page.cards);
  return out;
}
