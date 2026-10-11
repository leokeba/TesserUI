// Subscriptions (DESIGN.md §7.3): the renderer says what it wants watched,
// this keeps at most 3 subscriptions on the client and polls the rest (or
// everything, over plain HTTP), plus one for the tree's events.

import type { Client, Reply, Request } from '../client/types';
import { isUnder, segments } from '../model/schema';
import type { Store } from './store.svelte';

export interface SubSpec {
  path: string;
  keys?: string;
  depth?: number;
}

export const MAX_SUBSCRIPTIONS = 3;
export const POLL_MS = 1000;
const RETRY_MS = 5000;

// Events from the whole tree, for those that toast wherever the user is
// (DESIGN.md §7.8): a fourth subscription (TesserAPI allows 4 per client),
// without changes. Firmware that predates `changes` ignores it: the interval
// keeps the tree's changes to one notification a minute there.
export const EVENTS: Request = { op: 'sub', path: '/', changes: false, snapshot: false, interval: 60000 };

interface Active {
  spec: SubSpec;
  mode: 'sub' | 'poll';
  // A failed subscribe (peer offline, timeout) is retried.
  failed: boolean;
}

const keyOf = (s: SubSpec) => `${s.path}|${s.keys ?? ''}|${s.depth ?? ''}`;

export class Subscriptions {
  private active = new Map<string, Active>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  // The events subscription: 'none' once the node refused it (its budget).
  private events: 'off' | 'on' | 'failed' | 'none' = 'off';
  // Names of the children of a path, for reading a too-large page in pieces.
  childNames: (path: string) => string[] = () => [];

  constructor(
    private client: () => Client,
    private store: Store,
  ) {}

  // Replaces what is watched. Specs come in screen order: the first ones get
  // the subscriptions when there are more than the budget.
  want(specs: SubSpec[]) {
    const merged = new Map<string, SubSpec>();
    for (const s of specs) {
      // TesserAPI's unsub removes every subscription of a path, so a path is
      // subscribed once: same-path specs merge.
      const old = merged.get(s.path);
      merged.set(s.path, old ? mergeSpecs(old, s) : s);
    }
    const next = [...merged.values()];
    const nextKeys = new Set(next.map(keyOf));
    for (const [k, a] of this.active) {
      if (!nextKeys.has(k)) {
        this.active.delete(k);
        if (a.mode === 'sub' && !a.failed) {
          this.client().request({ op: 'unsub', path: a.spec.path });
          // That removed the events subscription too.
          if (a.spec.path === '/' && this.events === 'on') this.events = 'off';
        }
      }
    }
    let subs = [...this.active.values()].filter((a) => a.mode === 'sub').length;
    for (const spec of next) {
      const k = keyOf(spec);
      if (this.active.has(k)) continue;
      const mode = this.client().subscribes && subs < MAX_SUBSCRIPTIONS ? 'sub' : 'poll';
      if (mode === 'sub') subs++;
      const a: Active = { spec, mode, failed: false };
      this.active.set(k, a);
      if (mode === 'sub') this.subscribe(a);
      else this.read(spec);
    }
    // After the page's: they come first within the node's budget.
    if (this.events === 'off') this.subscribeEvents();
    this.schedule();
  }

  // After a reconnection: the node forgot every subscription.
  // fresh: the node still has them, at a lower level (a line that signed
  // in): replaced.
  renew(fresh = false) {
    let root = false;
    for (const a of this.active.values()) {
      if (a.mode === 'sub' && fresh && !a.failed) this.client().request({ op: 'unsub', path: a.spec.path });
      if (a.mode === 'sub') this.subscribe(a);
      else this.read(a.spec);
      root ||= a.mode === 'sub' && a.spec.path === '/';
    }
    if (this.events === 'none') return;
    // A page subscription at / was unsubscribed above, and this one with it.
    if (fresh && this.events === 'on' && !root) this.client().request({ op: 'unsub', path: '/' });
    this.subscribeEvents();
  }

  // Overflowed notifications: re-read whatever covers the path.
  reread(path: string) {
    for (const a of this.active.values()) if (isUnder(path, a.spec.path)) this.read(a.spec);
  }

  // Whether the page watches `path`: its events are shown there.
  covers(path: string): boolean {
    for (const { spec } of this.active.values()) {
      if (!isUnder(path, spec.path)) continue;
      const rest = segments(path).slice(segments(spec.path).length);
      if (spec.keys && rest.length && !spec.keys.split(',').includes(rest[0])) continue;
      if (spec.depth === undefined || rest.length <= spec.depth) return true;
    }
    return false;
  }

  stop() {
    const events = this.events;
    this.events = 'none';
    this.want([]);
    if (events === 'on') this.client().request({ op: 'unsub', path: '/' });
    clearInterval(this.pollTimer);
    clearInterval(this.retryTimer);
  }

  private schedule() {
    const polls = [...this.active.values()].some((a) => a.mode === 'poll');
    if (polls && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        for (const a of this.active.values()) if (a.mode === 'poll') this.read(a.spec);
      }, POLL_MS);
    } else if (!polls && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => {
        for (const a of this.active.values()) if (a.failed) this.subscribe(a);
        if (this.events === 'failed') this.subscribeEvents();
      }, RETRY_MS);
    }
  }

  private async subscribe(a: Active) {
    const { path, keys, depth } = a.spec;
    let r = await this.client().request({ op: 'sub', path, keys, depth, interval: 100 });
    if (!this.isCurrent(a)) return;
    if (r.status === 'too_large') {
      r = await this.client().request({ op: 'sub', path, keys, depth, interval: 100, snapshot: false });
      if (r.status === 'ok') {
        a.failed = false;
        await this.readInPieces(a.spec);
        return;
      }
    }
    if (r.status === 'ok') {
      a.failed = false;
      this.store.apply(path, r.body);
    } else if (r.status === 'not_allowed' || (r.status === 'busy' && !transient(r))) {
      // No subscription to be had here (budget, or below a list): poll.
      a.mode = 'poll';
      a.failed = false;
      this.schedule();
    } else {
      a.failed = true;
      if (!['timeout', 'disconnected', 'busy'].includes(r.status)) this.store.fail(path, r);
    }
  }

  private async subscribeEvents() {
    if (!this.client().subscribes) return;
    this.events = 'on';
    const r = await this.client().request(EVENTS);
    if (this.events !== 'on' || r.status === 'ok') return;
    const passing = ['timeout', 'disconnected'].includes(r.status) || (r.status === 'busy' && transient(r));
    this.events = passing ? 'failed' : 'none';
  }

  private async read(spec: SubSpec): Promise<Reply> {
    const r = await this.client().request({ op: 'get', path: spec.path, keys: spec.keys, depth: spec.depth });
    if (r.status === 'ok') this.store.apply(spec.path, r.body);
    else if (r.status === 'too_large') await this.readInPieces(spec);
    return r;
  }

  // One get per child, when the whole page doesn't fit in a response.
  private async readInPieces(spec: SubSpec) {
    const names = spec.keys ? spec.keys.split(',') : this.childNames(spec.path);
    for (const name of names) {
      const r = await this.client().request({ op: 'get', path: spec.path, keys: name, depth: spec.depth });
      if (r.status === 'ok') this.store.apply(spec.path, r.body);
    }
  }

  private isCurrent(a: Active) {
    return this.active.get(keyOf(a.spec)) === a;
  }
}

// `busy` for a reason that passes: a peer that can't be reached, too many
// forwarded calls at once, a full queue. Any other `busy` is the node's
// subscription limit.
function transient(r: Reply): boolean {
  return /couldn't send|pending|queue/.test(String((r.body as { message?: string } | null)?.message));
}

function mergeSpecs(a: SubSpec, b: SubSpec): SubSpec {
  const keys = a.keys && b.keys ? [...new Set([...a.keys.split(','), ...b.keys.split(',')])].join(',') : undefined;
  const depth = a.depth === undefined || b.depth === undefined ? undefined : Math.max(a.depth, b.depth);
  return { path: a.path, keys, depth };
}

// The deepest path that contains every path given.
export function commonAncestor(paths: string[]): string {
  if (!paths.length) return '/';
  let common = paths[0].split('/').filter(Boolean);
  for (const p of paths.slice(1)) {
    const s = p.split('/').filter(Boolean);
    let i = 0;
    while (i < common.length && i < s.length && common[i] === s[i]) i++;
    common = common.slice(0, i);
  }
  return '/' + common.join('/');
}
