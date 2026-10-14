import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from '../src/client/types';
import { buildLeaf, buildPage, type Leaf, type Section } from '../src/model/model';
import { accessAt, type Schema } from '../src/model/schema';
import { Session } from '../src/store/session.svelte';
import { FakeClient } from './fake';

const leaf = (s: Schema, name = 'x') => buildLeaf(name, `/${name}`, s, '/', '/');

describe('secrets (DESIGN §4)', () => {
  it('are password fields, never read', () => {
    expect(leaf({ type: 'string', writable: true, secret: true })).toMatchObject({ widget: 'password', secret: true, editable: true });
    // A secret is a password whatever widget is asked for.
    expect(leaf({ type: 'string', writable: true, secret: true, ui: { widget: 'textarea' } }).widget).toBe('password');
    expect(leaf({ type: 'string', secret: true }).widget).toBe('readout');
  });
});

describe('access levels (DESIGN §7.4)', () => {
  const tree: Schema = {
    type: 'object',
    children: {
      brightness: { type: 'integer', writable: true },
      net: {
        type: 'object',
        access: 'admin',
        children: { port: { type: 'integer', writable: true }, sub: { type: 'object', children: { x: { type: 'boolean', writable: true } } } },
      },
      users: { type: 'object', access: 'user', children: { name: { type: 'string', writable: true, access: 'admin' } } },
    },
  };
  it('are inherited down the model', () => {
    const page = buildPage(tree, '/');
    const [first, net, users] = page.cards;
    expect((first.items[0] as Leaf).access).toBeUndefined();
    expect(net.access).toBe('admin');
    expect((net.items[0] as Leaf).access).toBe('admin');
    expect(((net.items[1] as Section).items[0] as Leaf).access).toBe('admin');
    expect(users.access).toBe('user');
    expect((users.items[0] as Leaf).access).toBe('admin');
  });
  it('are found along a path, for pages and views', () => {
    expect(accessAt(tree, '/net/sub/x')).toBe('admin');
    expect(accessAt(tree, '/users')).toBe('user');
    expect(accessAt(tree, '/brightness')).toBeUndefined();
    expect(buildLeaf('x', '/net/sub/x', { type: 'boolean', writable: true }, '/net/sub', '/', accessAt(tree, '/net/sub')).access).toBe('admin');
    // A page below a protected object inherits it.
    expect(buildPage(tree.children!.net.children!.sub, '/net/sub', '/', undefined, 'admin').cards[0].items[0].access).toBe('admin');
  });
});

describe('actions (DESIGN §4, §5.2)', () => {
  it('give typed deferred actions their input', () => {
    expect(leaf({ type: 'action', arg: 'string', deferred: true })).toMatchObject({ widget: 'button', field: 'text', deferred: true });
    expect(leaf({ type: 'action', arg: 'any', deferred: true }).field).toBeUndefined();
  });
  it('send ui.value as a fixed argument, without a widget hint', () => {
    expect(leaf({ type: 'action', arg: 'integer', ui: { value: '$now' } })).toMatchObject({ widget: 'button', value: '$now' });
  });
  it('build an object argument into fields', () => {
    const a = leaf({
      type: 'action',
      arg: 'object',
      params: {
        type: 'object',
        children: {
          name: { type: 'string', writable: true },
          password: { type: 'string', writable: true, secret: true },
          at: { type: 'object', children: { az: { type: 'number', writable: true, min: 0, max: 360 } } },
        },
      },
    });
    expect(a.widget).toBe('button');
    expect(a.params?.map((p) => [p.path, p.widget])).toEqual([
      ['name', 'text'],
      ['password', 'password'],
      ['at/az', 'slider'],
    ]);
  });
});

describe('sign-in (DESIGN §7.4)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const root: Schema = {
    type: 'object',
    children: {
      sys: {
        type: 'object',
        children: {
          auth: {
            type: 'object',
            children: {
              login: {
                type: 'action',
                arg: 'object',
                returns: 'string',
                ui: { auth: 'login' },
                params: { type: 'object', children: { name: { type: 'string', writable: true }, password: { type: 'string', writable: true, secret: true } } },
              },
              whoami: { type: 'action', ui: { auth: 'whoami' } },
            },
          },
        },
      },
    },
  };

  function setup(level: () => string) {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const client = new FakeClient();
    client.answer = (r: Request) => {
      if (r.op === 'get') return { status: 'ok', body: root };
      if (r.path === '/sys/auth/whoami') return { status: 'ok', body: { access: level() } };
      if (r.path === '/sys/auth/login') {
        const b = r.body as { password?: string };
        return b.password === 'pw' ? { status: 'ok', body: { token: 'tok', access: 'admin' } } : { status: 'unauthorized', body: { error: 'unauthorized', message: 'wrong password' } };
      }
      return undefined;
    };
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    const internals = s as unknown as { use(c: FakeClient): void; load(): Promise<void> };
    internals.use(client);
    return { s, client, store, load: () => internals.load() };
  }

  it('learns the level from whoami, and signs in through login', async () => {
    let level = 'public';
    const { s, client, store, load } = setup(() => level);
    await load();
    expect(s.loaded).toBe(true);
    expect(s.login?.path).toBe('/sys/auth/login');
    expect(s.level).toBe('public');
    expect(s.can('admin')).toBe(false);
    expect(s.can(undefined)).toBe(true);

    expect(await s.signIn({ name: 'leo', password: 'nope' })).toBe('wrong password');
    expect(s.signedIn).toBe(false);

    level = 'admin';
    expect(await s.signIn({ name: 'leo', password: 'pw' })).toBeNull();
    expect(client.sent.find((r) => r.path === '/sys/auth/login')?.body).toEqual({ name: 'leo', password: 'nope' });
    expect(store.get('tesserui:token')).toBe('tok');
    expect(s.signedIn).toBe(true);
    // A new identity reads the schema again (the WebSocket reconnects).
    expect(s.loaded).toBe(false);
    await load();
    expect(s.level).toBe('admin');
    expect(s.can('admin')).toBe(true);

    s.signOut();
    expect(store.has('tesserui:token')).toBe(false);
    expect(s.signedIn).toBe(false);
  });

  it('disables nothing while the level is unknown', async () => {
    const { s } = setup(() => 'nonsense');
    expect(s.can('admin')).toBe(true);
  });
});

describe('schema cache (DESIGN §7.2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reuses a node schema while its view=hash holds', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    });
    vi.stubGlobal('location', new URL('http://node.local/'));
    let hash = '1a2b3c4d';
    const tree: Schema = { type: 'object', label: 'Lamp', children: { on: { type: 'boolean', writable: true } } };
    const open = async () => {
      const client = new FakeClient();
      client.answer = (r: Request) => (r.view === 'hash' ? { status: 'ok', body: hash } : r.view === 'schema' ? { status: 'ok', body: tree } : undefined);
      const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
      const internals = s as unknown as { use(c: FakeClient): void; load(): Promise<void> };
      internals.use(client);
      await internals.load();
      return { s, schemaReads: client.sent.filter((r) => r.view === 'schema').length };
    };
    expect((await open()).schemaReads).toBe(1);
    const again = await open();
    expect(again.schemaReads).toBe(0);
    expect(again.s.root.label).toBe('Lamp');
    hash = '99999999';
    expect((await open()).schemaReads).toBe(1);
  });

  it('keeps each node’s entries to itself', async () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    });
    vi.stubGlobal('location', new URL('https://launcher.example/'));
    const open = async (api: string, tree: Schema) => {
      const client = new FakeClient();
      client.answer = (r: Request) => (r.view === 'hash' ? { status: 'ok', body: 'samehash' } : r.view === 'schema' ? { status: 'ok', body: tree } : undefined);
      const s = new Session({ api, ws: '/ws', transport: 'ws', launcher: true });
      const internals = s as unknown as { use(c: FakeClient): void; load(): Promise<void> };
      internals.use(client);
      await internals.load();
      return { s, schemaReads: client.sent.filter((r) => r.view === 'schema').length };
    };
    // A host on the LAN answers with the real node's hash: what it serves
    // is cached under its own URL, never read for the real node.
    await open('http://localhost:8091/n/192.168.1.66/api', { type: 'object', label: 'Planted', ui: { widget: 'x-evil', script: '/ext/evil.js' } });
    const real = await open('http://localhost:8091/n/192.168.1.59/api', { type: 'object', label: 'Lamp' });
    expect(real.schemaReads).toBe(1);
    expect(real.s.root.label).toBe('Lamp');
    expect((await open('http://localhost:8091/n/192.168.1.59/api', { type: 'object', label: 'Changed' })).schemaReads).toBe(0);
  });
});
