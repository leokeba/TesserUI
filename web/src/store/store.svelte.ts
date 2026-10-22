// The values of one connection (DESIGN.md §7.1, §7.4): a sparse JSON tree of
// what is on screen, fed by snapshots and merge-patch notifications, with
// optimistic writes reconciled against the device's read-back values.

import { errorBody, errorText, type Client, type Notification, type Reply } from '../client/types';
import { isObject, parse, stringify } from '../client/json';
import { isUnder, parentPath, segments } from '../model/schema';
import { Toasts } from './toasts.svelte';

export interface EventEntry {
  // Unique: a burst of events shares one millisecond.
  n: number;
  t: number;
  path: string;
  body: unknown;
}

type Tree = Record<string, unknown> | unknown[];

const MAX_EVENTS = 8;
let eventCount = 0;

export class Store {
  values: Record<string, unknown> = $state({});
  // Writes sent and not answered yet (or a drag in progress), by path.
  pending: Record<string, number> = $state({});
  errors: Record<string, string> = $state({});
  events: Record<string, EventEntry[]> = $state({});
  // Paths whose values the node hasn't sent for a while (DESIGN.md §7.3):
  // what is under them shows as stale.
  stale: Record<string, boolean> = $state({});
  readonly toasts = new Toasts();
  // Bumped when chart history grows.
  historyTick = $state(0);

  // Paths with a place on screen; set by the page (see visiblePaths()).
  visible = new Set<string>();
  // Chart paths and their history length, in seconds.
  charts = new Map<string, number>();
  // Event paths keeping more than MAX_EVENTS (ui.lines), and how many.
  lines = new Map<string, number>();
  // Keyed lists (TesserAPI §4.4), by path: their key field. A path goes
  // through such a list by key (/sys/timers/morning/time), through other
  // arrays by index.
  keys = new Map<string, string>();
  onUnauthorized: (() => void) | null = null;
  // Every write the user makes, values and calls: "apply to all" (DESIGN.md §6.6).
  onWrite: ((path: string, body: unknown) => void) | null = null;
  // Each write and call the node took (a node's name: DESIGN.md §6.5).
  onWritten: ((path: string, body: unknown) => void) | null = null;
  // The interface's text (Session.t).
  t: (text: string) => string = (x) => x;

  // The device's values for each pending path, in the order they came:
  // notifications at or below a pending path (an object's fields, after a
  // patch written to it) land here instead of on screen.
  private confirmed = new Map<string, [string, unknown][]>();
  private history = new Map<string, [number, number][]>();
  private drags = new Map<
    string,
    { last: number; value: unknown; timer?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> }
  >();

  constructor(private client: () => Client) {}

  get(path: string): unknown {
    let v: unknown = this.values;
    let at = '';
    for (const s of segments(path)) {
      if (typeof v !== 'object' || v === null) return undefined;
      v = (v as Record<string, unknown>)[this.slot(v, at, s)];
      at += '/' + s;
    }
    return v;
  }

  // The property of `v` (at path `at`) that segment `s` names.
  private slot(v: object, at: string, s: string): string | number {
    const key = Array.isArray(v) && this.keys.get(at || '/');
    return key ? v.findIndex((e) => isObject(e) && e[key] === s) : s;
  }

  // Applies a notification or a read-back rooted at `path`, as TesserAPI
  // applies a set body: objects merge, everything else replaces.
  apply(path: string, body: unknown) {
    this.applyAt(segments(path), body);
  }

  // A snapshot or a read of a subtree also removes what it covers but
  // doesn't have (a node gone since), down to `depth` (objects below come as
  // {}, cut) and, at the top, among `keys`.
  snapshot(path: string, body: unknown, depth = Infinity, keys?: string) {
    this.applyAt(segments(path), body, depth, keys?.split(','));
  }

  private applyAt(segs: string[], body: unknown, left = NaN, only?: string[]) {
    const path = '/' + segs.join('/');
    const held = this.holding(path);
    if (held) return this.confirm(held, path, body);
    if (isObject(body)) {
      const cur = this.get(path);
      if (!isObject(cur)) this.setLocal(path, {});
      else if (left > 0) for (const k in cur) if (!(k in body) && (!only || only.includes(k))) delete cur[k];
      for (const [k, v] of Object.entries(body)) this.applyAt([...segs, k], v, left - 1);
      return;
    }
    this.setLocal(path, body);
  }

  private setLocal(path: string, value: unknown) {
    const segs = segments(path);
    if (!segs.length) {
      if (isObject(value)) this.values = value;
      return;
    }
    let parent: Tree = this.values;
    let at = '';
    for (const s of segs.slice(0, -1)) {
      const slot = this.slot(parent, at, s);
      if (slot === -1) return;  // no element with that key (yet)
      let next = (parent as Record<string, unknown>)[slot];
      if (typeof next !== 'object' || next === null) {
        next = {};
        (parent as Record<string, unknown>)[slot] = next;
      }
      parent = next as Tree;
      at += '/' + s;
    }
    const last = this.slot(parent, at, segs[segs.length - 1]);
    if (last === -1) return;
    (parent as Record<string, unknown>)[last] = value;
    this.sample(path, value);
  }

  // An optimistic value: an object is a patch, merged like a set body.
  private put(path: string, value: unknown) {
    if (!isObject(value)) return this.setLocal(path, value);
    if (!isObject(this.get(path))) this.setLocal(path, {});
    for (const [k, v] of Object.entries(value)) this.put(path === '/' ? `/${k}` : `${path}/${k}`, v);
  }

  private sample(path: string, value: unknown) {
    const seconds = this.charts.get(path);
    if (seconds === undefined || (typeof value !== 'number' && typeof value !== 'bigint')) return;
    const now = Date.now();
    let h = this.history.get(path);
    if (!h) this.history.set(path, (h = []));
    h.push([now, Number(value)]);
    while (h.length && h[0][0] < now - seconds * 1000) h.shift();
    this.historyTick++;
  }

  historyOf(path: string): [number, number][] {
    return this.history.get(path) ?? [];
  }

  // The innermost pending path at or above `path`.
  private holding(path: string): string | undefined {
    let held: string | undefined;
    for (const p in this.pending) if (isUnder(path, p) && p.length > (held?.length ?? -1)) held = p;
    return held;
  }

  // A value at the pending path itself replaces what came before it, unless
  // it is an object: a patch, merged.
  private confirm(held: string, path: string, body: unknown) {
    const q = this.confirmed.get(held)!;
    if (path === held && !isObject(body)) q.length = 0;
    q.push([path, body]);
  }

  // The value before the write, a copy (an object write changes it in place):
  // shown again if the write fails and nothing newer came.
  private hold(path: string) {
    const n = this.pending[path] ?? 0;
    const v = this.get(path);
    if (!n) this.confirmed.set(path, [[path, v === undefined ? v : parse(stringify(v))]]);
    this.pending[path] = n + 1;
  }

  // When the last pending write of a path is answered, the device's values
  // (the last read-back, newer notifications) replace the optimistic one.
  private release(path: string) {
    const left = (this.pending[path] ?? 1) - 1;
    if (left > 0) {
      this.pending[path] = left;
      return;
    }
    delete this.pending[path];
    const q = this.confirmed.get(path) ?? [];
    this.confirmed.delete(path);
    for (const [p, v] of q) if (v !== undefined) this.applyAt(segments(p), v);
  }

  isStale(path: string) {
    return Object.keys(this.stale).some((p) => isUnder(path, p));
  }

  // Optimistic write of a value: shown at once, sent, then reconciled. A
  // drag's writes go to other nodes (onWrite) once, with its final value.
  async write(path: string, value: unknown, drag = false): Promise<Reply> {
    this.hold(path);
    delete this.errors[path];
    this.put(path, value);
    if (!drag) this.onWrite?.(path, value);
    const r = await this.client().request({ op: 'set', path, body: value });
    if (r.status === 'ok') {
      this.succeed(path, r.body);
      this.onWritten?.(path, value);
    } else this.fail(path, r);
    this.release(path);
    return r;
  }

  // A keep-alive (DESIGN.md §7.4): the value again, not an edit. Nothing is
  // pending, so the device's notifications keep reaching the screen.
  async resend(path: string, value: unknown): Promise<boolean> {
    this.onWrite?.(path, value);
    const r = await this.client().request({ op: 'set', path, body: value });
    if (r.status !== 'ok') this.fail(path, r);
    else {
      this.apply(path, r.body);
      this.toasts.clear(path);
    }
    return r.status === 'ok';
  }

  // For sliders, knobs and color pickers: at most one write per `ms` while
  // dragging, always the final value, and no notification jitter meanwhile.
  writeSoon(path: string, value: unknown, ms = 100) {
    let d = this.drags.get(path);
    if (!d) {
      d = { last: 0, value };
      this.drags.set(path, d);
      this.hold(path);
    }
    d.value = value;
    clearTimeout(d.end);
    this.setLocal(path, value);
    if (d.timer) return;
    const drag = d;
    drag.timer = setTimeout(
      () => {
        drag.timer = undefined;
        drag.last = Date.now();
        const sent = drag.value;
        this.write(path, sent, true).then(() => {
          if (drag.timer || drag.value !== sent) return;
          // The drag ends once it has been quiet for `ms` after the last reply.
          drag.end = setTimeout(() => {
            if (drag.timer || drag.value !== sent || this.drags.get(path) !== drag) return;
            this.drags.delete(path);
            this.release(path);
            this.onWrite?.(path, sent);
          }, ms);
        });
      },
      Math.max(0, drag.last + ms - Date.now()),
    );
  }

  // Calls an action (or sends a form's patch); errors show like writes'.
  async call(path: string, arg: unknown, timeoutMs?: number): Promise<Reply> {
    delete this.errors[path];
    this.onWrite?.(path, arg ?? null);
    const r = await this.client().request({ op: 'set', path, body: arg ?? null }, timeoutMs);
    if (r.status !== 'ok') this.fail(path, r);
    else {
      this.toasts.clear(path);
      this.onWritten?.(path, arg ?? null);
    }
    return r;
  }

  private succeed(path: string, v: unknown) {
    this.confirm(path, path, v);
    this.toasts.clear(path);
  }

  // An error shows on the widget at its path, or its nearest visible
  // ancestor; with none on screen (another page), as a toast (DESIGN.md §7.8).
  fail(path: string, r: Reply) {
    const unauthorized = r.status === 'unauthorized';
    if (unauthorized) this.onUnauthorized?.();
    const at = errorBody(r).path ?? path;
    const shown = this.nearestVisible(at);
    const text = errorText(r, this.t);
    if (this.visible.has(shown)) this.errors[shown] = text;
    // The sign-in dialog says it already.
    else if (!unauthorized) this.toasts.show(text, 'error', at);
  }

  nearestVisible(path: string): string {
    let p = path;
    while (p !== '/' && !this.visible.has(p)) p = parentPath(p);
    return p;
  }

  notify(n: Notification) {
    if (n.op === 'change') {
      this.apply(n.path, n.body);
      return;
    }
    // Oldest first.
    const at = this.nearestVisible(n.path);
    const e = { n: ++eventCount, t: Date.now(), path: n.path, body: n.body };
    this.events[at] = [...(this.events[at] ?? []), e].slice(-(this.lines.get(at) ?? MAX_EVENTS));
  }

  // Errors are cleared by navigation (DESIGN.md §7.1).
  clearErrors(under = '/') {
    for (const p of Object.keys(this.errors)) if (isUnder(p, under)) delete this.errors[p];
  }
}
