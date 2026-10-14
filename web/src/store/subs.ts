// Subscriptions (DESIGN.md §7.3): the renderer says what it wants watched,
// this keeps at most 3 subscriptions on the client and polls the rest (or
// everything, over plain HTTP), plus one for the tree's events.

import { lowMemory, reason, type Client, type Reply, type Request } from '../client/types';
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
// A poll the node didn't answer waits twice as long each time, up to this.
const MAX_POLL_MS = 30000;
// Values not refreshed for this long, while the node fails to answer, are
// marked stale.
export const STALE_MS = 5000;

// Events from the whole tree, for those that toast wherever the user is
// (DESIGN.md §7.8): a fourth subscription (TesserAPI allows 4 per client),
// without changes, or a streamed GET over HTTP. Firmware that predates `changes` ignores it: the interval
// keeps the tree's changes to one notification a minute there.
export const EVENTS: Request = { op: 'sub', path: '/', changes: false, snapshot: false, interval: 60000 };

interface Active {
  spec: SubSpec;
  mode: 'sub' | 'poll';
  // A failed subscribe (peer offline, timeout) is retried; one the node had
  // no memory for, or refused (its subscription limit), not before `next`,
  // waiting longer each time.
  failed: boolean;
  tries: number;
  next: number;
  // Polls: one read at a time, every `wait` ms, not before `due`.
  reading?: boolean;
  wait: number;
  due: number;
  // The last time its values came.
  ok: number;
}

const keyOf = (s: SubSpec) => `${s.path}|${s.keys ?? ''}|${s.depth ?? ''}`;

export class Subscriptions {
  private active = new Map<string, Active>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setInterval> | undefined;
  // The events subscription: 'none' once stopped; one that failed is tried
  // again from `eventsAt`.
  private events: 'off' | 'on' | 'failed' | 'none' = 'off';
  private eventsAt = 0;
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
        delete this.store.stale[a.spec.path];
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
      const a: Active = { spec, mode, failed: false, tries: 0, next: 0, wait: POLL_MS, due: 0, ok: Date.now() };
      this.active.set(k, a);
      if (mode === 'sub') this.subscribe(a);
      else this.poll(a);
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
      else this.poll(a);
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

  // A new node behind the connection (DESIGN.md §7.3): it has none of the
  // subscriptions, and the page asks for its own again.
  forget() {
    this.active.clear();
    this.events = 'off';
    this.store.stale = {};
  }

  stop() {
    const events = this.events;
    this.events = 'none';
    this.want([]);
    if (events === 'on') this.client().request({ op: 'unsub', path: '/' });
    clearInterval(this.pollTimer);
    clearInterval(this.retryTimer);
  }

  // Polls and retries pause while the page is hidden (DESIGN.md §7.3).
  private schedule() {
    const polls = [...this.active.values()].some((a) => a.mode === 'poll');
    if (polls && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        if (hidden()) return;
        for (const a of this.active.values()) if (a.mode === 'poll' && !a.reading && Date.now() >= a.due) this.poll(a);
      }, POLL_MS);
    } else if (!polls && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => {
        if (hidden()) return;
        for (const a of this.active.values()) if (a.failed && Date.now() >= a.next) this.subscribe(a);
        if (this.events === 'failed' && Date.now() >= this.eventsAt) this.subscribeEvents();
      }, RETRY_MS);
    }
  }

  // One read at a time: a node that is busy or slow to answer is asked
  // less often, and its values marked stale after a while.
  private async poll(a: Active) {
    a.reading = true;
    const fresh = await this.read(a.spec);
    a.reading = false;
    a.wait = fresh ? POLL_MS : Math.min(a.wait * 2, MAX_POLL_MS);
    a.due = Date.now() + a.wait;
    this.mark(a, fresh);
  }

  private mark(a: Active, fresh: boolean) {
    const now = Date.now();
    if (fresh) a.ok = now;
    if (!this.isCurrent(a)) return;
    if (fresh) delete this.store.stale[a.spec.path];
    else if (now - a.ok > STALE_MS) this.store.stale[a.spec.path] = true;
  }

  private async subscribe(a: Active) {
    const { path, keys, depth } = a.spec;
    let r = await this.client().request({ op: 'sub', path, keys, depth, interval: 100 });
    if (!this.isCurrent(a)) return;
    if (r.status === 'too_large') {
      r = await this.client().request({ op: 'sub', path, keys, depth, interval: 100, snapshot: false });
      if (r.status === 'ok') {
        a.failed = false;
        a.mode = 'sub';
        this.mark(a, await this.readInPieces(a.spec));
        return;
      }
    }
    if (r.status === 'ok') {
      a.failed = false;
      a.tries = 0;
      a.mode = 'sub';
      this.store.snapshot(path, r.body, depth, keys);
      this.mark(a, true);
    } else if (r.status === 'not_allowed' || (r.status === 'busy' && !transient(r))) {
      // No subscription to be had here (below a list; the node's limit,
      // which other clients may free: tried again after 5 s, 10 s... 160 s):
      // poll.
      a.mode = 'poll';
      a.failed = r.status === 'busy';
      a.next = Date.now() + RETRY_MS * 2 ** Math.min(a.tries++, 5);
      this.schedule();
    } else {
      this.mark(a, false);
      a.failed = true;
      if (lowMemory(r)) {
        // A snapshot too large for the node's free memory, such as a peer's
        // whole tree, which its gateway subscribes to: the page is read in
        // pieces, and the subscription tried again after 5, 10, 20, 40 s.
        a.next = Date.now() + RETRY_MS * 2 ** Math.min(a.tries++, 3);
        await this.readInPieces(a.spec);
      } else if (!['timeout', 'disconnected', 'busy'].includes(r.status)) this.store.fail(path, r);
    }
  }

  // Over HTTP, a stream (HttpClient): the page's values are still polled.
  private async subscribeEvents() {
    this.events = 'on';
    const r = await this.client().request(EVENTS);
    if (this.events !== 'on' || r.status === 'ok') return;
    // Not to be had (a transport that can't deliver them; firmware without
    // streams): not asked for again on this node. Refused (its streams, held
    // by other pages): again in a minute.
    const passing = ['timeout', 'disconnected'].includes(r.status) || (r.status === 'busy' && transient(r));
    this.events = r.status === 'not_allowed' ? 'none' : 'failed';
    this.eventsAt = Date.now() + (passing ? 0 : 60000);
  }

  // Whether the values came: whole, or in pieces when too large (not for
  // want of memory: the node is short of it).
  private async read(spec: SubSpec): Promise<boolean> {
    const r = await this.client().request({ op: 'get', path: spec.path, keys: spec.keys, depth: spec.depth });
    if (r.status === 'ok') this.store.snapshot(spec.path, r.body, spec.depth, spec.keys);
    else if (r.status === 'too_large' || lowMemory(r)) return (await this.readInPieces(spec)) && !lowMemory(r);
    return r.status === 'ok';
  }

  // One get per child, when the whole page doesn't fit in a response.
  private async readInPieces(spec: SubSpec): Promise<boolean> {
    const names = spec.keys ? spec.keys.split(',') : this.childNames(spec.path);
    let all = true;
    for (const name of names) {
      const r = await this.client().request({ op: 'get', path: spec.path, keys: name, depth: spec.depth });
      if (r.status === 'ok') this.store.snapshot(spec.path, r.body, spec.depth, name);
      else all = false;
    }
    return all;
  }

  private isCurrent(a: Active) {
    return this.active.get(keyOf(a.spec)) === a;
  }
}

const hidden = () => !!globalThis.document?.hidden;

// `busy` for a reason that passes: a peer that can't be reached, too many
// forwarded calls at once, a full queue, not enough memory for the reply.
// Any other `busy` is the node's subscription limit (subscription_limit), or
// a file transfer holding the path.
const transient = (r: Reply) => ['low_memory', 'pending_limit', 'queue_full', 'unreachable'].includes(reason(r));

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
