import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/store.svelte';
import { Subscriptions, commonAncestor } from '../src/store/subs';
import { FakeClient, tick } from './fake';

function setup() {
  const client = new FakeClient();
  const store = new Store(() => client);
  return { client, store };
}

describe('store: merge patches (DESIGN §7.3)', () => {
  it('applies snapshots and notifications like set bodies', () => {
    const { store } = setup();
    store.apply('/', { lamp: { on: false, brightness: 10 }, list: [1, 2] });
    store.apply('/lamp', { brightness: 20 });
    store.apply('/', { list: [3] });
    store.apply('/lamp/on', true);
    expect(store.get('/lamp')).toEqual({ on: true, brightness: 20 });
    expect(store.get('/list')).toEqual([3]);
    expect(store.get('/list/0')).toBe(3);
    expect(store.get('/nope/x')).toBeUndefined();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('store: writes (DESIGN §7.4)', () => {
  it('is optimistic, then takes the read-back value', async () => {
    const { client, store } = setup();
    store.apply('/', { b: 10 });
    const done = store.write('/b', 12);
    expect(store.get('/b')).toBe(12);
    expect(store.pending['/b']).toBe(1);
    expect(client.sent[0]).toEqual({ op: 'set', path: '/b', body: 12 });
    client.reply('ok', 13);
    await done;
    expect(store.get('/b')).toBe(13);
    expect(store.pending['/b']).toBeUndefined();
  });
  it('holds notifications for a pending path until the reply', async () => {
    const { client, store } = setup();
    store.apply('/', { a: { b: 10, c: 1 } });
    const done = store.write('/a/b', 12);
    store.apply('/', { a: { b: 11, c: 2 } });
    expect(store.get('/a/b')).toBe(12);
    expect(store.get('/a/c')).toBe(2);
    client.reply('ok', 12);
    await done;
    expect(store.get('/a/b')).toBe(12);
  });
  it('restores the confirmed value on error and shows the message', async () => {
    const { client, store } = setup();
    store.apply('/', { b: 10 });
    store.visible.add('/b');
    const done = store.write('/b', 300);
    store.apply('/b', 11); // a newer device value arrives meanwhile
    client.reply('invalid_value', { error: 'invalid_value', path: '/b', message: 'expected integer in [0, 255]' });
    await done;
    expect(store.get('/b')).toBe(11);
    expect(store.errors['/b']).toBe('expected integer in [0, 255]');
  });
  it('maps errors to the nearest visible path and flags partial patches', async () => {
    const { client, store } = setup();
    store.visible.add('/form');
    const done = store.call('/form', { a: 1, go: null });
    client.reply('internal', { error: 'internal', path: '/form/hidden', message: 'failed', partial: true });
    await done;
    expect(store.errors['/form']).toBe('failed (some changes were applied)');
  });
  it('sends at most one write per 100 ms while dragging, always the last', async () => {
    vi.useFakeTimers();
    const { client, store } = setup();
    client.answer = (r) => ({ status: 'ok', body: r.body });
    store.apply('/', { s: 0 });
    store.writeSoon('/s', 1);
    store.writeSoon('/s', 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sent.map((r) => r.body)).toEqual([2]);
    store.writeSoon('/s', 3);
    store.apply('/s', 99); // held while dragging
    store.writeSoon('/s', 4);
    expect(store.get('/s')).toBe(4);
    await vi.advanceTimersByTimeAsync(50);
    expect(client.sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(client.sent.map((r) => r.body)).toEqual([2, 4]);
    await vi.advanceTimersByTimeAsync(200);
    expect(store.pending['/s']).toBeUndefined();
    expect(store.get('/s')).toBe(4);
  });
});

describe('store: events and charts', () => {
  it('routes events to the nearest visible path and toasts', () => {
    const { store } = setup();
    store.visible.add('/demo');
    store.toastLabels.set('/demo/fired', 'Fired');
    store.notify({ op: 'event', path: '/demo/fired', body: 3 });
    expect(store.events['/demo']?.[0]).toMatchObject({ path: '/demo/fired', body: 3 });
    expect(store.toasts[0].text).toBe('Fired: 3');
  });
  it('keeps chart history', () => {
    const { store } = setup();
    store.charts.set('/t', 60);
    store.apply('/', { t: 1 });
    store.apply('/t', 2);
    expect(store.historyOf('/t').map((h) => h[1])).toEqual([1, 2]);
  });
});

describe('subscriptions (DESIGN §7.3)', () => {
  it('keeps 3 subscriptions, polls the rest, and diffs', async () => {
    const { client, store } = setup();
    client.answer = (r) => ({ status: 'ok', body: r.op === 'unsub' ? 1 : {} });
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/a' }, { path: '/b' }, { path: '/c' }, { path: '/d', depth: 1 }]);
    await tick();
    expect(client.sent.filter((r) => r.op === 'sub').map((r) => r.path)).toEqual(['/a', '/b', '/c']);
    expect(client.sent.find((r) => r.op === 'get')?.path).toBe('/d');
    client.sent = [];
    subs.want([{ path: '/a' }, { path: '/b', keys: 'x' }]);
    await tick();
    expect(client.sent.map((r) => `${r.op} ${r.path}`)).toEqual(['unsub /b', 'unsub /c', 'sub /b']);
    subs.stop();
  });
  it('merges specs of one path', async () => {
    const { client, store } = setup();
    client.answer = () => ({ status: 'ok', body: {} });
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/', keys: 'a', depth: 1 }, { path: '/', keys: 'b', depth: 3 }]);
    await tick();
    expect(client.sent).toEqual([{ op: 'sub', path: '/', keys: 'a,b', depth: 3, interval: 100 }]);
    subs.stop();
  });
  it('reads in pieces when the snapshot is too large', async () => {
    const { client, store } = setup();
    client.answer = (r) =>
      r.op === 'sub' && r.snapshot === undefined ? { status: 'too_large', body: { error: 'too_large' } } : { status: 'ok', body: r.op === 'get' ? { [r.keys!]: 1 } : null };
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/', keys: 'a,b', depth: 2 }]);
    await tick();
    await tick();
    expect(store.get('/a')).toBe(1);
    expect(store.get('/b')).toBe(1);
    subs.stop();
  });
  it('finds common ancestors', () => {
    expect(commonAncestor(['/a/b/c', '/a/b/d', '/a/b'])).toBe('/a/b');
    expect(commonAncestor(['/a', '/b'])).toBe('/');
  });
});

describe('store: object writes', () => {
  it('merges an object written to a path, as a patch', async () => {
    const { client, store } = setup();
    store.apply('/', { sky: { sunAz: 100, targetAz: 1, targetEl: 2 } });
    const done = store.write('/sky', { targetAz: 10, targetEl: 20 });
    expect(store.get('/sky')).toEqual({ sunAz: 100, targetAz: 10, targetEl: 20 });
    client.reply('ok', { targetAz: 10, targetEl: 20 });
    await done;
    expect(store.get('/sky')).toEqual({ sunAz: 100, targetAz: 10, targetEl: 20 });
  });
});

describe('session: transport fallback', () => {
  it('falls back to HTTP once when the WebSocket never opens', async () => {
    const { Session } = await import('../src/store/session.svelte');
    const sockets: { onclose?: () => void }[] = [];
    class FailingSocket {
      onopen?: () => void;
      onclose?: () => void;
      onerror?: () => void;
      onmessage?: () => void;
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
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    s.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets.length).toBe(1);
    expect(s.kind).toBe('http');
    expect(fetched[0]).toBe('http://node.local/api/?depth=0');
    s.close();
    vi.unstubAllGlobals();
  });
});
