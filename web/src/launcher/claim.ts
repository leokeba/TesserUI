// Claiming (DESIGN.md §9.7.3): a first admin account for a node that has
// none, at `base`, the node's accounts (TesserKIT's /sys/auth: `open`,
// `users`, and its login action).
import { isObject } from '../client/json';
import { errorText } from '../client/types';
import type { Session } from '../store/session.svelte';

// Whether to offer it: the node says it is open, and the user isn't signed
// in. Its login action is how the new account signs in, so a node without
// one isn't offered it.
export async function claimable(session: Session, base: string): Promise<boolean> {
  if (!session.loaded || session.signedIn || !session.login) return false;
  const r = await session.ask({ op: 'get', path: base + '/open' });
  return r.status === 'ok' && r.body === true && session.loaded && !session.signedIn;
}

// Adds the account, then signs in with it: an error text, or ''. A keyed
// list is written whole: the accounts there are kept by name (their other
// fields too, TesserAPI §4.4), the new one added, or one of that name made
// admin.
export async function claim(session: Session, base: string, name: string, password: string): Promise<string> {
  const list = await session.ask({ op: 'get', path: base + '/users' });
  const kept = list.status === 'ok' && Array.isArray(list.body) ? list.body.filter((u) => isObject(u) && u.name !== name).map((u) => ({ name: (u as { name: unknown }).name })) : [];
  const r = await session.ask({ op: 'set', path: base + '/users', body: [...kept, { name, password, role: 'admin' }] });
  return r.status === 'ok' ? ((await session.signIn({ name, password })) ?? '') : errorText(r, session.store.t);
}
