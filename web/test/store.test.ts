import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store/store.svelte';
import { EVENTS, Subscriptions, commonAncestor } from '../src/store/subs';
import type { Schema } from '../src/model/schema';
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

// As TesserAPI renders a schema: an object or a list at the limit loses its
// children or its items.
const cut = (s: Schema, left: number): Schema => {
  if (s.type === 'object' && s.children) {
    if (left <= 0) return { ...s, children: undefined };
    return { ...s, children: Object.fromEntries(Object.entries(s.children).map(([k, c]) => [k, cut(c, left - 1)])) };
  }
  if (s.type === 'list' && s.items) {
    if (left <= 0) return { ...s, items: undefined };
    return { ...s, items: cut(s.items, left) };
  }
  return s;
};


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
  it('toasts errors with no place on screen, until a write there succeeds', async () => {
    const { client, store } = setup();
    store.visible.add('/lamp/on');
    let done = store.write('/motor/speed', 9);
    client.reply('invalid_value', { error: 'invalid_value', path: '/motor/speed', message: 'too fast' });
    await done;
    expect(store.errors).toEqual({});
    expect(store.toasts.list).toMatchObject([{ kind: 'error', text: 'too fast', path: '/motor/speed', count: 1 }]);
    done = store.write('/motor/speed', 9);
    client.reply('invalid_value', { error: 'invalid_value', path: '/motor/speed', message: 'too fast' });
    await done;
    expect(store.toasts.list).toMatchObject([{ count: 2 }]);
    done = store.write('/motor/speed', 5);
    client.reply('ok', 5);
    await done;
    expect(store.toasts.list).toEqual([]);
  });
  it("doesn't toast unauthorized: the sign-in dialog opens", async () => {
    const { client, store } = setup();
    store.onUnauthorized = vi.fn();
    const done = store.call('/go', null);
    client.reply('unauthorized', { error: 'unauthorized' });
    await done;
    expect(store.onUnauthorized).toHaveBeenCalled();
    expect(store.toasts.list).toEqual([]);
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
  it('routes events to the nearest visible path', () => {
    const { store } = setup();
    store.visible.add('/demo');
    store.notify({ op: 'event', path: '/demo/fired', body: 3 });
    expect(store.events['/demo']?.[0]).toMatchObject({ path: '/demo/fired', body: 3 });
  });
  it('keeps the last 8 events, or ui.lines, oldest first', () => {
    const { store } = setup();
    store.visible.add('/e').add('/log');
    store.lines.set('/log', 20);
    for (let i = 0; i < 30; i++) {
      store.notify({ op: 'event', path: '/e', body: i });
      store.notify({ op: 'event', path: '/log', body: `I (${i}) line` });
    }
    expect(store.events['/e'].map((e) => e.body)).toEqual([22, 23, 24, 25, 26, 27, 28, 29]);
    expect(store.events['/log'].length).toBe(20);
    expect(store.events['/log'][19].body).toBe('I (29) line');
    // Distinct, though they share a millisecond.
    expect(new Set(store.events['/log'].map((e) => e.n)).size).toBe(20);
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
    expect(client.sent.filter((r) => r.op === 'sub' && r !== EVENTS).map((r) => r.path)).toEqual(['/a', '/b', '/c']);
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
    expect(client.sent).toEqual([{ op: 'sub', path: '/', keys: 'a,b', depth: 3, interval: 100 }, EVENTS]);
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
  it("takes one more for the tree's events, after the page's", async () => {
    const { client, store } = setup();
    client.answer = (r) => ({ status: 'ok', body: r.op === 'unsub' ? 1 : null });
    const subs = new Subscriptions(() => client, store);
    const sent = () => client.sent.splice(0).map((r) => (r === EVENTS ? 'events' : `${r.op} ${r.path}`));
    subs.want([{ path: '/a' }, { path: '/b' }, { path: '/c' }]);
    await tick();
    expect(sent()).toEqual(['sub /a', 'sub /b', 'sub /c', 'events']);
    subs.want([{ path: '/' }]);
    await tick();
    expect(sent()).toEqual(['unsub /a', 'unsub /b', 'unsub /c', 'sub /']);
    // unsub removes every subscription at a path: the events one is renewed.
    subs.want([{ path: '/b', keys: 'x', depth: 1 }]);
    await tick();
    expect(sent()).toEqual(['unsub /', 'sub /b', 'events']);
    expect(subs.covers('/b/x')).toBe(true);
    expect(subs.covers('/b/x/y')).toBe(false);
    expect(subs.covers('/b/z')).toBe(false);
    expect(subs.covers('/a/x')).toBe(false);
    subs.stop();
    expect(sent()).toEqual(['unsub /b', 'unsub /']);
  });
  it("tries the events again a minute after the node refused them", async () => {
    vi.useFakeTimers();
    const { client, store } = setup();
    let refuse = true;
    client.answer = (r) => (r === EVENTS && refuse ? { status: 'busy', body: { error: 'busy', message: 'too many subscriptions' } } : { status: 'ok', body: null });
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/a' }]);
    await vi.advanceTimersByTimeAsync(0);
    client.sent = [];
    await vi.advanceTimersByTimeAsync(55000);
    expect(client.sent.filter((r) => r === EVENTS)).toHaveLength(0);
    refuse = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((r) => r === EVENTS)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(client.sent.filter((r) => r === EVENTS)).toHaveLength(1);
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

describe('session: lists cut by depth', () => {
  // TesserKIT's /sys/network/wifi/networks, three levels down.
  const networks: Schema = {
    type: 'list',
    key: 'ssid',
    items: { type: 'object', children: { ssid: { type: 'string', writable: true }, static: { type: 'object', children: { ip: { type: 'string', writable: true } } } } },
  };
  const tree: Schema = { type: 'object', children: { network: { type: 'object', children: { wifi: { type: 'object', children: { networks } } } } } };

  it('fetches a list whose items depth cut, and keeps them', async () => {
    const { Session } = await import('../src/store/session.svelte');
    const { schemaAt } = await import('../src/model/schema');
    const client = new FakeClient();
    client.answer = (r) => {
      if (r.view !== 'schema') return { status: 'ok', body: {} };
      const s = r.path === '/' ? tree : schemaAt(tree, r.path)!;
      return { status: 'ok', body: cut(s, r.depth ?? 99) };
    };
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    expect(await s.ensure('/', 3)).toBe(true);
    expect(client.sent.filter((r) => r.view === 'schema').map((r) => [r.path, r.depth])).toEqual([
      ['/', 3],
      ['/network/wifi/networks', 16],
    ]);
    expect(s.schemaAt('/network/wifi/networks')).toEqual(networks);
    // A shallower read of a parent keeps them.
    await s.fetchSchema('/network/wifi', 1);
    expect(s.schemaAt('/network/wifi/networks')).toEqual(networks);
  });
});

describe('session: events (DESIGN §7.8)', () => {
  const tree: Schema = {
    type: 'object',
    children: {
      lamp: { type: 'object', children: { on: { type: 'boolean', writable: true }, pressed: { type: 'event' }, blinked: { type: 'event', ui: { toast: 'warn' } } } },
      sys: {
        type: 'object',
        children: { net: { type: 'object', children: { wifi: { type: 'object', label: 'Wi-Fi', children: { joined: { type: 'event', ui: { toast: 'ok', hidden: true } } } } } } },
      },
    },
  };

  it('logs those the page shows, and toasts wherever the user is', async () => {
    const { Session } = await import('../src/store/session.svelte');
    const { schemaAt } = await import('../src/model/schema');
    const client = new FakeClient();
    client.answer = (r) => {
      if (r.view === 'schema') return { status: 'ok', body: cut(r.path === '/' ? tree : schemaAt(tree, r.path)!, r.depth ?? 99) };
      return { status: 'ok', body: r.op === 'unsub' ? 1 : null };
    };
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    await s.ensure('/', 2);
    s.subs.want([{ path: '/lamp' }]);
    s.store.visible.add('/lamp');
    await tick();
    expect(client.sent.some((r) => r === EVENTS)).toBe(true);

    client.push({ op: 'event', path: '/lamp/pressed', body: 1 });
    client.push({ op: 'event', path: '/lamp/blinked', body: 2 });
    await tick();
    expect(s.store.events['/lamp'].map((e) => e.path)).toEqual(['/lamp/pressed', '/lamp/blinked']);
    expect(s.store.toasts.list).toMatchObject([{ kind: 'warn', text: '2', path: '/lamp/blinked' }]);

    // Off the page and below what was loaded: its schema is read first. A
    // hidden one is a toast only.
    expect(s.schemaAt('/sys/net/wifi/joined')).toBeUndefined();
    client.push({ op: 'event', path: '/sys/net/wifi/joined', body: '192.168.1.50 on Workshop' });
    await vi.waitFor(() => expect(s.store.toasts.list.length).toBe(2));
    expect(s.store.toasts.list[1]).toMatchObject({ kind: 'ok', text: '192.168.1.50 on Workshop', path: '/sys/net/wifi/joined' });
    expect(Object.keys(s.store.events)).toEqual(['/lamp']);
    s.close();
  });
});

describe("session: a view's item a peer lacks", () => {
  // TesserKIT's overview repeats $/led over /peers; the Gledopto has none.
  it('is unavailable on the item, without a toast (DESIGN §7.8)', async () => {
    const { Session } = await import('../src/store/session.svelte');
    const client = new FakeClient();
    client.answer = (r) => {
      if (r.path === '/') return { status: 'ok', body: { type: 'object', children: { peers: { type: 'object', children: { gled: { type: 'remote', id: '20500d1b02bc' } } } } } };
      if (r.path === '/peers/gled') return { status: 'ok', body: { type: 'object', children: { outputs: { type: 'object' } } } };
      return { status: 'not_found', body: { error: 'not_found', path: r.path, message: 'no such node' } };
    };
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    expect(await s.ensure('/peers/gled/led', 3, true)).toBe(false);
    expect(client.sent.at(-1)).toMatchObject({ path: '/peers/gled/led', view: 'schema' });
    expect(s.store.toasts.list).toEqual([]);
    // A page's read still says why it failed.
    expect(await s.ensure('/peers/gled/led')).toBe(false);
    expect(s.store.toasts.list).toMatchObject([{ kind: 'error', text: 'no such node', path: '/peers/gled/led' }]);
  });
});

// TesserAPI dba7c1f: a node short of memory for a reply answers busy. A
// gateway's upstream subscription takes a peer's whole tree, which crashed
// DEVKIT-R1 before (4.8 KB over UDP).
describe('a node short of memory', () => {
  const short = { status: 'busy', body: { error: 'busy', message: 'not enough memory for the response' } };
  it('gets its subscription again later, read in pieces meanwhile, without polling or a toast', async () => {
    vi.useFakeTimers();
    const { client, store } = setup();
    let memory = false;
    client.answer = (r) => (r.op === 'sub' && r !== EVENTS && !memory ? short : { status: 'ok', body: r.op === 'get' ? { [r.keys!]: 1 } : null });
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/peers/r1', keys: 'a,b', depth: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get('/peers/r1/a')).toBe(1);
    expect(store.get('/peers/r1/b')).toBe(1);
    const sent = () => client.sent.splice(0).filter((r) => r !== EVENTS).map((r) => `${r.op} ${r.keys ?? ''}`);
    expect(sent()).toEqual(['sub a,b', 'get a', 'get b']);
    // Not polled each second; tried again after 5 s, then 10 s.
    await vi.advanceTimersByTimeAsync(4000);
    expect(sent()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent()).toEqual(['sub a,b', 'get a', 'get b']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent()).toEqual([]);
    memory = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent()).toEqual(['sub a,b']);
    await vi.advanceTimersByTimeAsync(20000);
    expect(sent()).toEqual([]);
    expect(store.toasts.list).toEqual([]);
    subs.stop();
    vi.useRealTimers();
  });
  it("reads a schema a level at a time, and doesn't toast", async () => {
    const { Session } = await import('../src/store/session.svelte');
    const { schemaAt } = await import('../src/model/schema');
    const tree: Schema = { type: 'object', children: { a: { type: 'object', children: { x: { type: 'integer' } } }, b: { type: 'integer' } } };
    const client = new FakeClient();
    client.answer = (r) => (r.view === 'schema' && (r.depth ?? 0) > 1 ? short : { status: 'ok', body: r.view === 'hash' ? null : schemaAt(tree, r.path) });
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    (s as unknown as { use(c: FakeClient): void }).use(client);
    expect(await s.fetchSchema('/', 3)).toBe(true);
    expect(client.sent.map((r) => `${r.path} ${r.depth}`)).toEqual(['/ 3', '/ 1', '/a 2', '/a 1']);
    expect(s.schemaAt('/a/x')).toEqual({ type: 'integer' });
    expect(s.store.toasts.list).toEqual([]);
  });
});

describe('a node under load (DESIGN §7.3)', () => {
  const gets = (c: FakeClient) => c.sent.splice(0).filter((r) => r.op === 'get').length;

  it('polls one read at a time, less often while it is busy, and marks its values stale', async () => {
    vi.useFakeTimers();
    const { client, store } = setup();
    client.subscribes = false;
    let busy = false;
    client.answer = (r) => (r.op !== 'get' ? { status: 'ok', body: null } : busy ? { status: 'busy', body: { error: 'busy', message: 'too many pending requests' } } : undefined);
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/a', depth: 1 }]);
    // A read the node doesn't answer isn't asked again meanwhile.
    await vi.advanceTimersByTimeAsync(3000);
    expect(gets(client)).toBe(1);
    client.reply('ok', { x: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(gets(client)).toBe(1);
    client.reply('ok', { x: 2 });
    busy = true;
    // Busy: 1 s, then 2, 4, 8 s between reads.
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000);
    expect(gets(client)).toBe(4);
    expect(store.isStale('/a/x')).toBe(true);
    expect(store.isStale('/b')).toBe(false);
    busy = false;
    // The next read, 16 s later (on the next second's tick), brings them back.
    await vi.advanceTimersByTimeAsync(17000);
    client.reply('ok', { x: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.isStale('/a/x')).toBe(false);
    expect(store.get('/a/x')).toBe(3);
    subs.stop();
  });

  it('pauses polls while the page is hidden', async () => {
    vi.useFakeTimers();
    const doc = { hidden: true };
    vi.stubGlobal('document', doc);
    const { client, store } = setup();
    client.subscribes = false;
    client.answer = () => ({ status: 'ok', body: {} });
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/a' }]);
    await vi.advanceTimersByTimeAsync(0);
    gets(client);
    await vi.advanceTimersByTimeAsync(10000);
    expect(gets(client)).toBe(0);
    doc.hidden = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(gets(client)).toBe(1);
    subs.stop();
    vi.unstubAllGlobals();
  });

  it('subscribes again once the node has a subscription to spare', async () => {
    vi.useFakeTimers();
    const { client, store } = setup();
    let full = true;
    client.answer = (r) =>
      r.op === 'sub' && r !== EVENTS && full ? { status: 'busy', body: { error: 'busy', message: 'too many subscriptions' } } : { status: 'ok', body: r.op === 'get' ? {} : null };
    const subs = new Subscriptions(() => client, store);
    subs.want([{ path: '/a' }]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(gets(client)).toBeGreaterThan(0);
    full = false;
    await vi.advanceTimersByTimeAsync(5000);
    client.sent = [];
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.sent.filter((r) => r.op !== 'sub' || r === EVENTS)).toEqual([]);
    subs.stop();
  });
});

describe('apply to all, while dragging (DESIGN §6.6)', () => {
  it('sends the final value once', async () => {
    vi.useFakeTimers();
    const { client, store } = setup();
    client.answer = (r) => ({ status: 'ok', body: r.body });
    const applied: unknown[] = [];
    store.onWrite = (_p, v) => applied.push(v);
    for (let v = 1; v <= 10; v++) {
      store.writeSoon('/speed', v);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.sent.filter((r) => r.op === 'set').length).toBeGreaterThan(2);
    expect(applied).toEqual([10]);
  });
});
