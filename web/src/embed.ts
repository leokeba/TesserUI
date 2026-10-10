// Mounting a UI (DESIGN.md §9.9): the node's own page does it on
// document.body; an application embeds one or more anywhere.

import { mount, unmount } from 'svelte';
import App from './App.svelte';
import { Session, type Config } from './store/session.svelte';

export type Options = Partial<Config> & { api: string };

export interface Mounted {
  session: Session;
  destroy(): void;
}

// The WebSocket defaults to /ws on the API's host; null means HTTP only.
export function resolve(o: Options): Config {
  const ws = o.ws !== undefined ? o.ws : new URL('/ws', new URL(o.api, location.href)).href;
  return { ...o, ws, transport: o.transport ?? (ws ? 'ws' : 'http') };
}

export function mountUi(target: HTMLElement, options: Options): Mounted {
  const session = new Session(resolve(options));
  session.start();
  const app = mount(App, { target, props: { session, full: target === document.body } });
  return {
    session,
    destroy() {
      unmount(app);
      session.close();
    },
  };
}
