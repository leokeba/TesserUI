import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from '../src/client/types';
import type { Schema } from '../src/model/schema';
import { Session } from '../src/store/session.svelte';
import { FakeClient, tick } from './fake';

// A gateway whose name is a setting (TesserKIT's /sys/name), with values of
// its own and a peer (DESIGN §6.5, §6.6).
describe("a node's name and its own values", () => {
  afterEach(() => vi.unstubAllGlobals());

  function node() {
    vi.stubGlobal('location', new URL('http://node.local/'));
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    });
    const dev = { hash: 'aaaa0001', label: 'TesserKIT', peerHash: 'bbbb0001', peerLabel: 'Lamp' };
    const tree = (): Schema => ({
      type: 'object',
      label: dev.label,
      children: {
        sys: { type: 'object', children: { name: { type: 'string', writable: true, ui: { nodeName: true } }, host: { type: 'string', writable: true, ui: { perNode: true } }, level: { type: 'integer', writable: true } } },
        ap: { type: 'object', ui: { form: true }, children: { ssid: { type: 'string', writable: true, ui: { perNode: true } }, password: { type: 'string', writable: true }, apply: { type: 'action', arg: 'none' } } },
        peers: { type: 'object', children: { lamp: { type: 'remote', schema: dev.peerHash, id: 'c8f09ef4a67c' } } },
      },
    } as Schema);
    const client = new FakeClient();
    client.answer = (r: Request) => {
      if (r.view === 'info') return { status: 'ok', body: { protocol: 2, features: ['info'], hash: dev.hash, id: 'aabbccddeeff' } };
      if (r.view === 'schema' && r.path === '/') return { status: 'ok', body: r.depth === 0 ? { type: 'object', label: dev.label } : tree() };
      if (r.view === 'schema' && r.path === '/peers') return { status: 'ok', body: { type: 'object', children: { lamp: { type: 'remote', schema: dev.peerHash, id: 'c8f09ef4a67c' } } } };
      if (r.view === 'schema' && r.path === '/peers/lamp') return { status: 'ok', body: { type: 'object', label: dev.peerLabel, children: r.depth ? { sys: { type: 'object', children: { name: { type: 'string', writable: true, ui: { nodeName: true } } } } } : undefined } };
      return { status: 'ok', body: null };
    };
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    return { s, client, dev };
  }
  const settle = async () => {
    for (let i = 0; i < 10; i++) await tick();
  };

  it('reads the root label again after the name is written, past the cache', async () => {
    const { s, client, dev } = node();
    client.state('open');
    await settle();
    expect(s.nodeLabel('/')).toBe('TesserKIT');
    dev.label = 'Kitchen';
    dev.hash = 'aaaa0002';
    client.sent.length = 0;
    await s.store.write('/sys/name', 'Kitchen');
    await settle();
    expect(client.sent.map((r) => [r.op, r.path, r.view ?? null])).toEqual([
      ['set', '/sys/name', null],
      ['get', '/', 'info'],
      ['get', '/', 'schema'],
    ]);
    expect(s.nodeLabel('/')).toBe('Kitchen');
    // The tree stays.
    expect(s.schemaAt('/sys/level')).toBeTruthy();
    // Other writes don't.
    client.sent.length = 0;
    await s.store.write('/sys/level', 3);
    await settle();
    expect(client.sent.length).toBe(1);
  });

  it("a peer's name too, through the gateway", async () => {
    const { s, client, dev } = node();
    client.state('open');
    await settle();
    await s.ensure('/peers/lamp', 3);
    expect(s.nodeLabel('/peers/lamp')).toBe('Lamp');
    dev.peerLabel = 'Porch';
    client.sent.length = 0;
    await s.store.write('/peers/lamp/sys/name', 'Porch');
    await settle();
    expect(client.sent.map((r) => [r.op, r.path, r.depth ?? null])).toEqual([
      ['set', '/peers/lamp/sys/name', null],
      ['get', '/peers/lamp', 0],
    ]);
    expect(s.nodeLabel('/peers/lamp')).toBe('Porch');
  });

  it("apply to all leaves out the node's own values, inside forms too", async () => {
    const { s, client } = node();
    client.state('open');
    await settle();
    s.all = true;
    const others = () => client.sent.filter((r) => r.op === 'set' && r.path.startsWith('/peers/lamp')).map((r) => [r.path, r.body]);
    await s.store.write('/sys/name', 'Kitchen');
    await s.store.write('/sys/host', 'kitchen');
    await s.store.call('/ap', { ssid: 'Kitchen', password: 'secret', apply: null });
    await s.store.write('/sys/level', 3);
    await settle();
    expect(others()).toEqual([
      ['/peers/lamp/ap', { password: 'secret', apply: null }],
      ['/peers/lamp/sys/level', 3],
    ]);
  });

  it("watches the peers' stubs on the gateway's own pages, and drops a renamed peer's tree", async () => {
    const { s, client, dev } = node();
    client.state('open');
    await settle();
    await s.ensure('/peers/lamp', 1);
    s.show([], [{ path: '/sys', depth: 1 }], '/sys');
    await settle();
    expect(client.sent.some((r) => r.op === 'sub' && r.path === '/peers' && r.depth === 1 && !r.keys)).toBe(true);
    expect(s.nodeLabel('/peers/lamp')).toBe('Lamp');
    // The peer advertises another hash: its tree is no longer its own.
    vi.useFakeTimers();
    dev.peerHash = 'bbbb0002';
    client.push({ op: 'change', path: '/peers', body: { lamp: null } });
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
    expect(s.schemaAt('/peers/lamp')?.schema).toBe('bbbb0002');
    expect(s.schemaAt('/peers/lamp')?.tree).toBeUndefined();
    expect(s.nodeLabel('/peers/lamp')).toBe('lamp');
  });
});
