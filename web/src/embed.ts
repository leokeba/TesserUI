// Mounting a UI (DESIGN.md §9.9): the node's own page does it on
// document.body; an application embeds one or more anywhere.

import { mount, unmount } from 'svelte';
import App from './App.svelte';
import Theme from './Theme.svelte';
import { Session, type Config } from './store/session.svelte';

export type Options = Partial<Config> & { api: string };

export interface Mounted {
  session: Session;
  destroy(): void;
}

// The WebSocket defaults to /ws on the API's host; null means HTTP only.
// An HTTPS page can't open ws:// to a node on the network (mixed content,
// which Chrome's local network access doesn't lift for WebSockets): it polls.
export function resolve(o: Options): Config {
  const api = new URL(o.api, location.href);
  const mixed = location.protocol === 'https:' && api.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(api.host);
  const ws = o.ws !== undefined ? o.ws : mixed ? null : new URL('/ws', api).href;
  return { ...o, ws, transport: o.transport ?? (ws ? 'ws' : 'http') };
}

export function mountUi(target: HTMLElement, options: Options): Mounted {
  const session = new Session(resolve(options));
  session.start();
  // The theme first: App's own rules come after it, and win a tie.
  const theme = mount(Theme, { target });
  const app = mount(App, { target, props: { session, full: target === document.body } });
  return {
    session,
    destroy() {
      unmount(app);
      unmount(theme);
      session.close();
    },
  };
}
