import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from '../src/client/types';
import { claim, claimable } from '../src/launcher/claim';
import type { Schema } from '../src/model/schema';
import { Session } from '../src/store/session.svelte';
import { FakeClient } from './fake';

// TesserKIT's /sys/auth (its DESIGN §5.7): `open` while no admin account
// exists, keyed `users`, the login action.
const root: Schema = {
  type: 'object',
  children: {
    sys: {
      type: 'object',
      children: {
        auth: {
          type: 'object',
          children: {
            users: { type: 'list', writable: true, key: 'name', items: { type: 'object', children: {} } },
            login: { type: 'action', arg: 'object', ui: { auth: 'login' } },
            open: { type: 'boolean' },
          },
        },
      },
    },
  },
};

describe('claiming (DESIGN §9.7.3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(o: { open?: boolean; login?: boolean; set?: (r: Request) => { status: string; body: unknown } } = {}) {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const tree = structuredClone(root);
    if (o.login === false) delete tree.children!.sys.children!.auth.children!.login;
    const client = new FakeClient();
    client.answer = (r: Request) => {
      if (r.path === '/sys/auth/open') return { status: 'ok', body: o.open ?? true };
      if (r.path === '/sys/auth/users' && r.op === 'get') return { status: 'ok', body: [{ name: 'leo', password: null, role: 'user' }, { name: 'admin', password: null, role: 'user' }] };
      if (r.path === '/sys/auth/users') return o.set?.(r) ?? { status: 'ok', body: null };
      if (r.path === '/sys/auth/login') return { status: 'ok', body: { token: 'tok', access: 'admin' } };
      if (r.op === 'get') return { status: 'ok', body: tree };
      return undefined;
    };
    const s = new Session({ api: '/api', ws: '/ws', transport: 'ws' });
    const internals = s as unknown as { use(c: FakeClient): void; load(): Promise<void> };
    internals.use(client);
    return { s, client, store, load: () => internals.load() };
  }

  it('is offered while the node is open and the user signed out', async () => {
    const { s, load } = setup();
    expect(await claimable(s, '/sys/auth')).toBe(false); // not loaded
    await load();
    expect(await claimable(s, '/sys/auth')).toBe(true);
    s.signedIn = true;
    expect(await claimable(s, '/sys/auth')).toBe(false);
  });

  it('is not offered by a closed node, nor one without a login action', async () => {
    const closed = setup({ open: false });
    await closed.load();
    expect(await claimable(closed.s, '/sys/auth')).toBe(false);
    const noLogin = setup({ login: false });
    await noLogin.load();
    expect(await claimable(noLogin.s, '/sys/auth')).toBe(false);
  });

  it('adds the admin, keeping the other accounts by name, then signs in', async () => {
    const { s, client, store, load } = setup();
    await load();
    expect(await claim(s, '/sys/auth', 'admin', 'pw')).toBe('');
    const set = client.sent.find((r) => r.op === 'set' && r.path === '/sys/auth/users');
    expect(set?.body).toEqual([{ name: 'leo' }, { name: 'admin', password: 'pw', role: 'admin' }]);
    expect(client.sent.find((r) => r.path === '/sys/auth/login')?.body).toEqual({ name: 'admin', password: 'pw' });
    expect(store.get('tesserui:token')).toBe('tok');
    expect(s.signedIn).toBe(true);
  });

  it("says why the node refused, and doesn't sign in", async () => {
    const { s, client, load } = setup({ set: () => ({ status: 'invalid_value', body: { error: 'invalid_value', message: '1 to 64 characters', path: '/sys/auth/users/0/password' } }) });
    await load();
    expect(await claim(s, '/sys/auth', 'admin', 'x'.repeat(65))).toBe('1 to 64 characters');
    expect(client.sent.some((r) => r.path === '/sys/auth/login')).toBe(false);
    expect(s.signedIn).toBe(false);
  });
});
