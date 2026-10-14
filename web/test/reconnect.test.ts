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

describe('reconnection (DESIGN §7.3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function node() {
    vi.stubGlobal('location', new URL('http://node.local/'));
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
      if (r.view === 'hash') return { status: 'ok', body: dev.hash };
      if (r.view === 'schema') return { status: 'ok', body: r.depth === 0 ? { type: 'object', id: dev.id } : { ...dev.tree, id: dev.id } };
      if (r.op === 'get' || r.op === 'sub') return { status: 'ok', body: dev.values };
      return { status: 'ok', body: null };
    };
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    return { s, client, dev };
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await tick();
  };
  const schemaReads = (c: FakeClient) => c.sent.filter((r) => r.view === 'schema' && r.depth !== 0).length;

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
      ['get', 'hash'],
      ['get', 'schema'],
      ['sub', null],
      ['sub', null],
    ]);
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
});
