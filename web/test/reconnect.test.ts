import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from '../src/client/types';
import type { Schema } from '../src/model/schema';
import { Session } from '../src/store/session.svelte';
import { Store } from '../src/store/store.svelte';
import { FakeClient, tick } from './fake';

describe('snapshots replace what they cover (DESIGN §7.3)', () => {
  const store = () => new Store(() => new FakeClient());

  it('removes children gone from the node', () => {
    const s = store();
    s.apply('/', { a: { x: 1, y: 2 }, b: 3 });
    s.snapshot('/', { a: { x: 1 } });
    expect(s.values).toEqual({ a: { x: 1 } });
  });

  it('keeps objects cut by depth, and children outside its keys', () => {
    const s = store();
    s.apply('/', { a: { deep: { v: 1 }, gone: 2 }, other: 5 });
    // depth 1: a's children are listed, deep is {} (cut).
    s.snapshot('/a', { deep: {} }, 1);
    expect(s.values).toEqual({ a: { deep: { v: 1 } }, other: 5 });
    s.apply('/', { m: { p: 1, q: 2 } });
    s.snapshot('/', { m: { p: 1 } }, 2, 'm');
    expect(s.values).toEqual({ a: { deep: { v: 1 } }, other: 5, m: { p: 1 } });
  });

});

describe.each([1, 2])('reconnection, protocol %i (DESIGN §7.5)', (protocol) => {
  afterEach(() => vi.unstubAllGlobals());

  // own: the node's own page (its API on the page's origin); else a UI
  // embedded in another page.
  function node(own = false) {
    const reload = vi.fn();
    vi.stubGlobal('location', Object.assign(new URL(own ? 'http://node.local/' : 'http://elsewhere.local/'), { reload }));
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    });
    const dev = {
      hash: 'aaaa0001',
      id: 'c8f09ef4a67c',
      tree: { type: 'object', children: { lamp: { type: 'boolean', writable: true }, old: { type: 'integer' } } } as Schema,
      values: { lamp: true, old: 4 } as Record<string, unknown>,
    };
    const client = new FakeClient();
    client.answer = (r: Request) => {
      // Protocol 2: view=info; 1: view=hash and the root at depth 0.
      if (r.view === 'info') return protocol > 1 ? { status: 'ok', body: { protocol, features: ['info'], hash: dev.hash, id: dev.id } } : { status: 'bad_request', body: { error: 'bad_request' } };
      if (r.view === 'hash') return { status: 'ok', body: dev.hash };
      if (r.view === 'schema') return { status: 'ok', body: r.depth === 0 ? { type: 'object', id: dev.id } : { ...dev.tree, id: dev.id } };
      if (r.op === 'get' || r.op === 'sub') return { status: 'ok', body: dev.values };
      return { status: 'ok', body: null };
    };
    const s = new Session({ api: 'http://node.local/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    return { s, client, dev, saved, reload };
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await tick();
  };
  const schemaReads = (c: FakeClient) => c.sent.filter((r) => r.view === 'schema' && r.depth !== 0).length;

  it('says a node that stops answering after an action is restarting, and reads it again (DESIGN §6.7)', async () => {
    const { s, client } = node();
    client.state('open');
    await settle();
    const answer = client.answer!;
    let down = false;
    client.answer = (r) => (down ? { status: 'timeout', body: null } : answer(r));
    let reopened = 0;
    client.close = () => client.state('down');
    client.connect = () => void reopened++;
    vi.useFakeTimers();
    // One that keeps answering isn't.
    s.watchNode();
    await vi.advanceTimersByTimeAsync(4000);
    expect([s.restarting, reopened]).toEqual([false, 0]);
    s.watchNode();
    down = true;
    await vi.advanceTimersByTimeAsync(1100);
    // A WebSocket may never hear a restarted node close: opened again.
    expect([s.restarting, reopened]).toEqual([true, 1]);
    // Its values are read again (its schema too, unless its hash says it's
    // the cached one).
    s.store.values = { lamp: false };
    down = false;
    client.state('open');
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    expect(s.restarting).toBe(false);
    expect(s.loaded).toBe(true);
    s.subs.want([{ path: '/', depth: 1 }]);
    await settle();
    expect(s.store.values).toEqual({ lamp: true, old: 4 });
  });

  it('renews the subscriptions when the node is the same', async () => {
    const { s, client } = node();
    client.state('open');
    await settle();
    expect(s.loaded).toBe(true);
    s.subs.want([{ path: '/', depth: 1 }]);
    await settle();
    client.state('down');
    client.sent.length = 0;
    client.state('open');
    await settle();
    expect(s.loaded).toBe(true);
    expect(client.sent.map((r) => [r.op, r.view ?? null])).toEqual([
      ['get', 'info'],
      ...(protocol > 1 ? [] : [['get', 'hash'], ['get', 'schema']]),
      ['sub', null],
      ['sub', null],
    ]);
    expect(client.protocol).toBe(protocol);
    expect(client.features).toEqual(protocol > 1 ? ['info'] : undefined);
  });

  it('gives its subscriptions back while hidden, and takes them again when shown', async () => {
    const doc = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', doc);
    const show = (hidden: boolean) => ((doc.hidden = hidden), doc.dispatchEvent(new Event('visibilitychange')));
    const { s, client, dev } = node();
    client.state('open');
    await settle();
    s.subs.want([{ path: '/', depth: 1 }]);
    await settle();
    vi.useFakeTimers();
    const sent = () => client.sent.splice(0).map((r) => [r.op, r.path, r.view ?? null].join(' ').trim());
    sent();
    // A quick look at another tab: nothing changes.
    show(true);
    await vi.advanceTimersByTimeAsync(20000);
    show(false);
    show(true);
    await vi.advanceTimersByTimeAsync(20000);
    expect(sent()).toEqual([]);
    // The page's and the events subscription: both at /.
    await vi.advanceTimersByTimeAsync(10000);
    expect(sent()).toEqual(['unsub /', 'unsub /']);
    await vi.advanceTimersByTimeAsync(60000);
    expect(sent()).toEqual([]);
    dev.values = { lamp: false, old: 4 };
    show(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toEqual(['get / info', ...(protocol > 1 ? [] : ['get / hash', 'get / schema']), 'sub /', 'sub /']);
    expect(s.store.values).toEqual({ lamp: false, old: 4 });
    s.close();
    vi.useRealTimers();
  });

  it("reloads the node's own page after a new firmware, which may bring another bundle", async () => {
    const { client, dev, reload } = node(true);
    client.state('open');
    await settle();
    client.state('down');
    dev.hash = 'bbbb0002';
    client.state('open');
    await settle();
    expect(reload).toHaveBeenCalledOnce();
    // The same firmware back (a restart): no reload.
    const again = node(true);
    again.client.state('open');
    await settle();
    again.client.state('down');
    again.client.state('open');
    await settle();
    expect(again.reload).not.toHaveBeenCalled();
  });

  it('reads everything again after a new firmware (another hash)', async () => {
    const { s, client, dev } = node();
    client.state('open');
    await settle();
    s.subs.want([{ path: '/', depth: 1 }]);
    await settle();
    expect(s.store.values).toEqual({ lamp: true, old: 4 });
    client.state('down');
    dev.hash = 'bbbb0002';
    dev.tree = { type: 'object', children: { lamp: { type: 'boolean', writable: true }, added: { type: 'string' } } };
    dev.values = { lamp: false, added: 'new' };
    client.sent.length = 0;
    client.state('open');
    await settle();
    expect(s.loaded).toBe(true);
    expect(schemaReads(client)).toBe(1);
    expect(Object.keys(s.root.children ?? {})).toEqual(['lamp', 'added']);
    // The node forgot the subscriptions, and the page asks for its own again.
    expect(s.store.values).toEqual({});
    s.subs.want([{ path: '/', depth: 1 }]);
    await settle();
    expect(s.store.values).toEqual({ lamp: false, added: 'new' });
  });

  it('reads everything again when another device answers at the address', async () => {
    const { s, client, dev } = node();
    client.state('open');
    await settle();
    client.state('down');
    dev.id = '10521c75f37c';
    client.sent.length = 0;
    client.state('open');
    await settle();
    expect(s.loaded).toBe(true);
    expect(schemaReads(client)).toBe(1);
  });

  // 64-bit values (TesserAPI's uint64_t) go through the schema cache and
  // toasts exactly; a broken cache entry is read again from the node.
  it('caches and shows 64-bit values exactly', async () => {
    const { s, client, dev, saved } = node();
    const big = 18446744073709551615n;
    dev.tree.children!.old = { type: 'integer', max: big as unknown as number };
    dev.tree.children!.alarm = { type: 'event', ui: { toast: 'warn' } };
    client.state('open');
    await settle();
    expect(s.loaded).toBe(true);
    client.sent.length = 0;
    expect(await s.fetchSchema('/', 3)).toBe(true);
    expect(schemaReads(client)).toBe(0);
    expect(s.schemaAt('/old')?.max).toBe(big);
    for (const k of saved.keys()) if (k.startsWith('tesserui:schema:')) saved.set(k, '{');
    expect(await s.fetchSchema('/', 3)).toBe(true);
    expect(schemaReads(client)).toBe(1);
    client.push({ op: 'event', path: '/alarm', body: { count: big } });
    await settle();
    expect(s.store.toasts.list.map((t) => t.text)).toEqual(['{"count":18446744073709551615}']);
  });
});
