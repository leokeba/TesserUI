// What the renderer asks of a node, and how it notices one that's gone:
// requests it mustn't repeat, subscriptions it mustn't leave behind.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnvelopeClient, type Link } from '../src/client/envelope';
import { HttpClient } from '../src/client/http';
import type { Request } from '../src/client/types';
import { buildPage } from '../src/model/model';
import type { Schema } from '../src/model/schema';
import { Session, storageSet } from '../src/store/session.svelte';
import { Store } from '../src/store/store.svelte';
import { Subscriptions } from '../src/store/subs';
import { FakeClient, tick } from './fake';

// localStorage: its entries are its own keys, as Object.keys() reads them.
class Memory {
  [key: string]: unknown;
  full = false;
  getItem(k: string) {
    return (this[k] as string) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.full && Object.keys(this).some((x) => x.startsWith('tesserui:schema:'))) throw new Error('QuotaExceededError');
    this[k] = v;
  }
  removeItem(k: string) {
    delete this[k];
  }
}
Object.defineProperty(Memory.prototype, 'full', { enumerable: false, writable: true });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('peers behind a gateway (DESIGN §6.5)', () => {
  it("reads each peer's root once, though every reply shows the page again", async () => {
    vi.stubGlobal('location', new URL('http://gw/'));
    vi.stubGlobal('localStorage', new Memory());
    const peers: Record<string, Schema> = {};
    for (let i = 0; i < 6; i++) peers['p' + i] = { type: 'remote', online: true, schema: 'h' + i } as Schema;
    const root: Schema = { type: 'object', children: { peers: { type: 'object', children: peers } } };
    const client = new FakeClient();
    client.answer = (r: Request) => {
      if (r.view === 'info') return { status: 'ok', body: { protocol: 2, hash: 'x', id: 'gw' } };
      if (r.view === 'schema' && r.path === '/') return { status: 'ok', body: root };
      if (r.op !== 'get' || r.view !== 'schema') return { status: 'ok', body: null };
      return undefined;
    };
    const s = new Session({ api: 'http://gw/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    client.state('open');
    for (let i = 0; i < 10; i++) await tick();
    // As Page does: the page shown again on every merge.
    let seen = -1;
    const show = () => {
      if (s.schemaVersion === seen) return;
      seen = s.schemaVersion;
      s.showPage(buildPage(s.schemaAt('/peers')!, '/peers', '/', (t: string) => t));
    };
    show();
    for (let i = 0; i < 20; i++) {
      const h = client.held.shift();
      h?.resolve({ status: 'ok', body: { type: 'object', label: h.req.path } });
      for (let j = 0; j < 5; j++) await tick();
      show();
    }
    const reads = client.sent.filter((r) => r.view === 'schema' && r.depth === 0 && r.path.startsWith('/peers/'));
    expect(reads.map((r) => r.path)).toEqual(Object.keys(peers).map((p) => '/peers/' + p));
    s.close();
  });

  it('shares a schema read in flight', async () => {
    vi.stubGlobal('location', new URL('http://gw/'));
    const client = new FakeClient();
    const s = new Session({ api: 'http://gw/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { client: FakeClient }).client = client;
    const both = Promise.all([s.fetchSchema('/a', 1), s.fetchSchema('/a', 1)]);
    expect(client.sent).toHaveLength(1);
    client.reply('ok', { type: 'object', children: {} });
    expect(await both).toEqual([true, true]);
  });
});

describe('the schema cache (DESIGN §7.2)', () => {
  it('keeps one entry per node and path, which a new hash replaces', async () => {
    vi.stubGlobal('location', new URL('http://elsewhere.local/'));
    const saved = new Memory();
    vi.stubGlobal('localStorage', saved);
    let hash = 'aaaa0001';
    const client = new FakeClient();
    client.answer = (r: Request) => {
      if (r.view === 'info') return { status: 'ok', body: { protocol: 2, hash, id: 'dev' } };
      if (r.view === 'schema') return { status: 'ok', body: { type: 'object', children: { lamp: { type: 'boolean' } } } };
      return { status: 'ok', body: null };
    };
    const s = new Session({ api: 'http://node.local/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    const entries = () => Object.entries(saved).filter(([k]) => k.startsWith('tesserui:schema:'));
    client.state('open');
    for (let i = 0; i < 10; i++) await tick();
    expect(entries()).toHaveLength(1);
    // New firmware: another hash.
    hash = 'aaaa0002';
    client.state('down');
    client.state('open');
    for (let i = 0; i < 10; i++) await tick();
    expect(entries()).toHaveLength(1);
    expect(entries()[0][1]).toMatch(/^aaaa0002\n/);
    s.close();
  });

  it('gives way to a token at the quota', () => {
    const saved = new Memory();
    vi.stubGlobal('localStorage', saved);
    saved['tesserui:schema:old'] = '{}';
    saved.full = true;
    storageSet('tesserui:schema:new', '{}');
    expect(saved['tesserui:schema:new']).toBeUndefined();
    storageSet('tesserui:token', 'abc');
    expect(saved['tesserui:token']).toBe('abc');
    expect(saved['tesserui:schema:old']).toBeUndefined();
  });
});

describe('subscriptions that time out (DESIGN §7.3)', () => {
  it('are given back before they are asked for again, and when the page goes', async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.answer = (r) => (r.op === 'sub' && r.path === '/a' ? { status: 'timeout', body: null } : { status: 'ok', body: null });
    const subs = new Subscriptions(() => client, new Store(() => client));
    subs.want([{ path: '/a' }]);
    await vi.advanceTimersByTimeAsync(5000);
    subs.want([]);
    expect(client.sent.filter((r) => r.path === '/a').map((r) => r.op)).toEqual(['sub', 'unsub', 'sub', 'unsub']);
    subs.stop();
  });

  it("aren't given back when the node refused them", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.answer = (r) => (r.op === 'sub' && r.path === '/a' ? { status: 'busy', body: { error: 'busy', reason: 'subscription_limit' } } : { status: 'ok', body: {} });
    const subs = new Subscriptions(() => client, new Store(() => client));
    subs.want([{ path: '/a' }]);
    await vi.advanceTimersByTimeAsync(5000);
    subs.want([]);
    const ops = client.sent.filter((r) => r.path === '/a').map((r) => r.op);
    expect(ops.filter((op) => op === 'sub')).toHaveLength(2);
    expect(ops).not.toContain('unsub');
    subs.stop();
  });
});

describe('a WebSocket to a node that is gone (DESIGN §7.5)', () => {
  // A link that opens, and answers every envelope unless `dead`.
  function link() {
    const l = { opened: 0, sent: [] as Request[], dead: false, closed: 0 };
    const make = (): Link => {
      let receive: (text: string) => void;
      return {
        open: (onMessage) => ((receive = onMessage), l.opened++, Promise.resolve()),
        send: (text) => {
          const env = JSON.parse(text);
          l.sent.push(env);
          if (!l.dead) setTimeout(() => receive(JSON.stringify({ id: env.id, status: 'ok', body: {} })));
        },
        close: () => void l.closed++,
      };
    };
    return { l, client: new EnvelopeClient('ws', make) };
  }

  it('asks a silent one for its view=info, and keeps one that answers', async () => {
    vi.useFakeTimers();
    const { l, client } = link();
    client.connect();
    await vi.advanceTimersByTimeAsync(15000);
    expect(l.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(l.sent.length).toBeGreaterThan(0);
    expect(l.sent.every((r) => r.view === 'info')).toBe(true);
    expect([client.state, l.opened]).toEqual(['open', 1]);
    client.close();
  });

  it('drops one whose checks go unanswered, and connects again', async () => {
    vi.useFakeTimers();
    const { l, client } = link();
    const states: string[] = [];
    client.onState((s) => states.push(s));
    client.connect();
    l.dead = true;
    await vi.advanceTimersByTimeAsync(40000);
    expect(l.sent).toHaveLength(2);
    expect(l.closed).toBe(1);
    expect(states).toEqual(['connecting', 'open', 'down']);
    l.dead = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect([client.state, l.opened]).toEqual(['open', 2]);
    client.close();
  });
});

describe('HTTP: a slow node (DESIGN §9.2)', () => {
  it("goes down when a request can't reach it, not when one is slow", async () => {
    vi.useFakeTimers();
    vi.stubGlobal('location', new URL('http://node.local/'));
    let mode: 'ok' | 'slow' | 'refused' = 'ok';
    vi.stubGlobal('fetch', (_: string, init: RequestInit) => {
      if (mode === 'ok') return Promise.resolve(new Response('{}'));
      if (mode === 'refused') return Promise.reject(new TypeError('Failed to fetch'));
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const c = new HttpClient('http://node.local/api', () => null);
    c.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.state).toBe('open');
    mode = 'slow';
    const r = c.request({ op: 'get', path: '/a' });
    await vi.advanceTimersByTimeAsync(6000);
    expect([(await r).status, c.state]).toEqual(['timeout', 'open']);
    const r2 = c.request({ op: 'get', path: '/a' });
    await vi.advanceTimersByTimeAsync(6000);
    expect([(await r2).status, c.state]).toEqual(['timeout', 'open']);
    // Nothing has answered for 15 s: down.
    const r3 = c.request({ op: 'get', path: '/a' });
    await vi.advanceTimersByTimeAsync(6000);
    expect([(await r3).status, c.state]).toEqual(['timeout', 'down']);
    mode = 'ok';
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.state).toBe('open');
    mode = 'refused';
    expect((await c.request({ op: 'get', path: '/a' })).status).toBe('disconnected');
    expect(c.state).toBe('down');
    c.close();
  });
});

describe('session: closed (DESIGN §9.2)', () => {
  it("doesn't fall back to HTTP, nor probe for a WebSocket, once closed", async () => {
    vi.useFakeTimers();
    const sockets: unknown[] = [];
    class FailingSocket {
      onclose?: () => void;
      onerror?: () => void;
      constructor() {
        sockets.push(this);
        setTimeout(() => this.onclose?.(), 0);
      }
      close() {}
      send() {}
    }
    vi.stubGlobal('WebSocket', FailingSocket);
    vi.stubGlobal('location', new URL('http://node.local/'));
    const fetched: string[] = [];
    vi.stubGlobal('fetch', (url: string) => (fetched.push(url), Promise.reject(new Error('offline'))));
    // Closed before its WebSocket opened: no HTTP.
    const early = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    early.start();
    early.close();
    await vi.advanceTimersByTimeAsync(100);
    expect([early.kind, fetched.length]).toEqual(['ws', 0]);
    // Fallen back to HTTP, then closed: no WebSocket probes.
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    s.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(s.kind).toBe('http');
    const n = sockets.length;
    s.close();
    await vi.advanceTimersByTimeAsync(300000);
    expect(sockets.length).toBe(n);
  });
});
