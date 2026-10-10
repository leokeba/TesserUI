// The values of one connection (DESIGN.md §7.1, §7.4): a sparse JSON tree of
// what is on screen, fed by snapshots and merge-patch notifications, with
// optimistic writes reconciled against the device's read-back values.

import { errorBody, errorText, type Client, type Notification, type Reply } from '../client/types';
import { isObject } from '../client/json';
import { isUnder, parentPath, segments } from '../model/schema';

export interface EventEntry {
  t: number;
  path: string;
  body: unknown;
}

export interface Toast {
  id: number;
  text: string;
}

type Tree = Record<string, unknown> | unknown[];

const MAX_EVENTS = 8;

export class Store {
  values: Record<string, unknown> = $state({});
  // Writes sent and not answered yet (or a drag in progress), by path.
  pending: Record<string, number> = $state({});
  errors: Record<string, string> = $state({});
  events: Record<string, EventEntry[]> = $state({});
  toasts: Toast[] = $state([]);
  // Bumped when chart history grows.
  historyTick = $state(0);

  // Paths with a place on screen; set by the page (see visiblePaths()).
  visible = new Set<string>();
  // Event paths that also toast, with their labels.
  toastLabels = new Map<string, string>();
  // Chart paths and their history length, in seconds.
  charts = new Map<string, number>();
  // Keyed lists (TesserAPI §4.4), by path: their key field. A path goes
  // through such a list by key (/sys/timers/morning/time), through other
  // arrays by index.
  keys = new Map<string, string>();
  onUnauthorized: (() => void) | null = null;
  // The interface's text (Session.t).
  t: (text: string) => string = (x) => x;

  // The device's last value for each pending path: notifications for a
  // pending path land here instead of on screen.
  private confirmed = new Map<string, unknown>();
  private history = new Map<string, [number, number][]>();
  private drags = new Map<
    string,
    { last: number; value: unknown; timer?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> }
  >();
  private toastId = 0;

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

  // Applies a snapshot, a notification or a read-back rooted at `path`, as
  // TesserAPI applies a set body: objects merge, everything else replaces.
  apply(path: string, body: unknown) {
    this.applyAt(segments(path), body);
  }

  private applyAt(segs: string[], body: unknown) {
    const path = '/' + segs.join('/');
    if (this.pending[path]) {
      this.confirmed.set(path, body);
      return;
    }
    if (isObject(body)) {
      const cur = this.get(path);
      if (!isObject(cur)) this.setLocal(path, {});
      for (const [k, v] of Object.entries(body)) this.applyAt([...segs, k], v);
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

  private hold(path: string) {
    const n = this.pending[path] ?? 0;
    if (!n) this.confirmed.set(path, this.get(path));
    this.pending[path] = n + 1;
  }

  // When the last pending write of a path is answered, the device's value
  // (the last read-back, or a newer notification) replaces the optimistic one.
  private release(path: string) {
    const left = (this.pending[path] ?? 1) - 1;
    if (left > 0) {
      this.pending[path] = left;
      return;
    }
    delete this.pending[path];
    const v = this.confirmed.get(path);
    this.confirmed.delete(path);
    if (v !== undefined) this.applyAt(segments(path), v);
  }

  // Optimistic write of a value: shown at once, sent, then reconciled.
  async write(path: string, value: unknown): Promise<Reply> {
    this.hold(path);
    delete this.errors[path];
    this.put(path, value);
    const r = await this.client().request({ op: 'set', path, body: value });
    if (r.status === 'ok') this.confirmed.set(path, r.body);
    else this.fail(path, r);
    this.release(path);
    return r;
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
        this.write(path, sent).then(() => {
          if (drag.timer || drag.value !== sent) return;
          // The drag ends once it has been quiet for `ms` after the last reply.
          drag.end = setTimeout(() => {
            if (drag.timer || drag.value !== sent || this.drags.get(path) !== drag) return;
            this.drags.delete(path);
            this.release(path);
          }, ms);
        });
      },
      Math.max(0, drag.last + ms - Date.now()),
    );
  }

  // Calls an action (or sends a form's patch); errors show like writes'.
  async call(path: string, arg: unknown, timeoutMs?: number): Promise<Reply> {
    delete this.errors[path];
    const r = await this.client().request({ op: 'set', path, body: arg ?? null }, timeoutMs);
    if (r.status !== 'ok') this.fail(path, r);
    return r;
  }

  fail(path: string, r: Reply) {
    if (r.status === 'unauthorized') this.onUnauthorized?.();
    this.errors[this.nearestVisible(errorBody(r).path ?? path)] = errorText(r, this.t);
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
    const at = this.nearestVisible(n.path);
    this.events[at] = [{ t: Date.now(), path: n.path, body: n.body }, ...(this.events[at] ?? [])].slice(0, MAX_EVENTS);
    const label = this.toastLabels.get(n.path);
    if (label !== undefined) this.toast(n.body === null ? label : `${label}: ${typeof n.body === 'string' ? n.body : JSON.stringify(n.body)}`);
  }

  toast(text: string) {
    const id = ++this.toastId;
    this.toasts.push({ id, text });
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), 3000);
  }

  // Errors are cleared by navigation (DESIGN.md §7.1).
  clearErrors(under = '/') {
    for (const p of Object.keys(this.errors)) if (isUnder(p, under)) delete this.errors[p];
  }
}
