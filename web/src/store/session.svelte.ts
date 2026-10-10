// One connection to a node (or a UI host and the peers behind it): the
// client, the schema tree fetched so far, the store and the subscriptions.

import { EnvelopeClient, serialLink, webSocketLink } from '../client/envelope';
import { HttpClient } from '../client/http';
import { isObject } from '../client/json';
import type { Client, ConnState, Notification, Reply, Request } from '../client/types';
import type { Condition } from '../model/conditions';
import { visiblePaths, type Item, type Leaf, type Page, type Section } from '../model/model';
import { isUnder, joinPath, mergeSchema, parentPath, remoteOf, schemaAt, segments, type Schema } from '../model/schema';
import type { ViewPage } from '../model/views';
import { Store } from './store.svelte';
import { commonAncestor, Subscriptions, type SubSpec } from './subs';

export interface Config {
  api: string;
  ws: string | null;
  transport: 'ws' | 'http' | 'serial';
  minVersion?: string;
}

const TOKEN_KEY = 'tesserui:token';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode, full: the cache is only a cache
  }
}

export class Session {
  state: ConnState = $state('connecting');
  // Bumped whenever the schema tree changes: models derive from it.
  schemaVersion = $state(0);
  views: ViewPage[] | null = $state(null);
  loaded = $state(false);
  needToken = $state(false);
  // The node's own root, once known: its label names the device.
  root: Schema = { type: 'object' };
  store: Store;
  subs: Subscriptions;
  private client!: Client;
  private stubRefresh = new Map<string, ReturnType<typeof setTimeout>>();
  private remotePaths: string[] = [];

  constructor(readonly config: Config) {
    this.store = new Store(() => this.client);
    this.store.onUnauthorized = () => (this.needToken = true);
    this.subs = new Subscriptions(() => this.client, this.store);
    this.subs.childNames = (path) => {
      const s = this.schemaAt(path);
      return Object.keys((s?.type === 'remote' ? s.tree : s)?.children ?? {});
    };
  }

  get kind() {
    return this.client?.kind;
  }

  token(): string | null {
    return storageGet(TOKEN_KEY);
  }

  setToken(token: string) {
    storageSet(TOKEN_KEY, token);
    this.needToken = false;
    // The WebSocket authenticates on its handshake: reconnect.
    if (this.client.kind === 'ws') {
      this.client.close();
      this.client.connect();
    }
  }

  start() {
    if (this.config.transport === 'serial') return; // waits for useSerial()
    if (this.config.transport === 'http' || !this.config.ws) return this.use(this.httpClient());
    const ws = new EnvelopeClient('ws', () => webSocketLink(this.wsUrl()));
    // A node without enableWebSocket(): fall back to HTTP for good.
    ws.onState((s) => {
      if (s === 'down' && ws.opened === 0 && this.client === ws) {
        // Switch first: closing emits 'down' again.
        this.use(this.httpClient());
        ws.close();
      }
    });
    this.use(ws);
  }

  // Web Serial: the port comes from a user gesture (navigator.serial.requestPort()).
  useSerial(port: Parameters<typeof serialLink>[0]) {
    this.use(new EnvelopeClient('serial', () => serialLink(port)));
  }

  private httpClient() {
    return new HttpClient(new URL(this.config.api, location.href).href.replace(/\/$/, ''), () => this.token());
  }

  private wsUrl(): string {
    const ws = this.config.ws!;
    const url = new URL(ws, location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = this.token();
    if (token) url.searchParams.set('token', token);
    return url.href;
  }

  private use(client: Client) {
    this.client = client;
    client.onNotify((n) => this.notify(n));
    client.onState((s) => {
      if (this.client !== client) return;
      const wasDown = this.state !== 'open';
      this.state = s;
      if (s !== 'open' || !wasDown) return;
      if (!this.loaded) this.load();
      else this.subs.renew();
    });
    client.connect();
  }

  private async load() {
    if (!(await this.fetchSchema('/', 3))) return;
    // Views first: they decide the landing page.
    const ui = this.root.children?._ui;
    if (ui?.type === 'custom') {
      const r = await this.client.request({ op: 'get', path: '/_ui' });
      if (r.status === 'ok' && isObject(r.body) && Array.isArray(r.body.pages)) this.views = r.body.pages as unknown as ViewPage[];
    }
    this.loaded = true;
  }

  private notify(n: Notification) {
    this.store.notify(n);
    if (n.op !== 'change') return;
    if (n.overflow) this.subs.reread(n.path);
    // A remote node's value turning up in a change ({"peer": null}) means its
    // stub changed: online state or advertised schema (TesserAPI §14.1).
    for (const r of this.remotePaths) {
      if (!isUnder(r, n.path)) continue;
      let v: unknown = n.body;
      for (const s of segments(r.slice(n.path === '/' ? 0 : n.path.length))) v = isObject(v) ? v[s] : undefined;
      if (v === null) this.refreshStub(r);
    }
  }

  private refreshStub(path: string) {
    if (this.stubRefresh.has(path)) return;
    this.stubRefresh.set(
      path,
      setTimeout(async () => {
        this.stubRefresh.delete(path);
        const parent = parentPath(path);
        const name = path.slice(path.lastIndexOf('/') + 1);
        const r = await this.ask({ op: 'get', path: parent, view: 'schema', depth: 1, keys: name });
        if (r.status === 'ok') this.merge(parent, r.body as Schema);
      }, 300),
    );
  }

  schemaAt(path: string): Schema | undefined {
    return schemaAt(this.root, path);
  }

  // The schema of the page at `path`, if loaded (a remote node's own tree for
  // a peer's root). Reading schemaVersion makes callers reactive.
  pageSchema(path: string): Schema | undefined {
    void this.schemaVersion;
    const s = this.schemaAt(path);
    const tree = s?.type === 'remote' ? s.tree : s;
    return tree?.children ? tree : undefined;
  }

  // The root of the node `path` belongs to: '/' or a remote node's path.
  nodeRoot(path: string): string {
    return remoteOf(this.root, path)?.path ?? '/';
  }

  isOffline(path: string): boolean {
    void this.schemaVersion;
    let s: Schema | undefined = this.root;
    for (const name of segments(path)) {
      if (s?.type === 'remote') {
        if (s.online === false) return true;
        s = s.tree;
      }
      s = s?.children?.[name];
    }
    return s?.type === 'remote' && s.online === false;
  }

  private merge(path: string, fetched: Schema) {
    mergeSchema(this.root, path, fetched);
    this.remotePaths = collectRemotes(this.root, '/');
    this.schemaVersion++;
  }

  // Makes sure the schema at `path` is known `depth` levels down.
  async ensure(path: string, depth = 3): Promise<boolean> {
    const known = this.schemaAt(path);
    if (known && known.type !== 'object' && known.type !== 'remote') return true;
    if (this.pageSchema(path)) {
      const s = this.schemaAt(path)!;
      if (!hasLazyChildren(s.type === 'remote' ? s.tree! : s, depth)) return true;
    }
    if (!this.root.children && path !== '/') await this.fetchSchema('/', 1);
    // Each level on the way must be known, to cross remote nodes.
    const names = segments(path);
    for (let i = 1; i < names.length; i++) {
      const p = '/' + names.slice(0, i).join('/');
      const s = this.schemaAt(p);
      if (!s) return false;
      if ((s.type === 'object' && !s.children) || (s.type === 'remote' && !s.tree?.children)) {
        if (!(await this.fetchSchema(p, 1))) return false;
      }
    }
    return this.fetchSchema(path, depth);
  }

  // A gateway forwards at most maxPending requests at once (TesserAPI's
  // default: 4) and answers `busy` beyond: schema reads wait and retry.
  private async ask(r: Request): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      const reply = await this.client.request(r);
      const pendingLimit = reply.status === 'busy' && /pending/.test(String((reply.body as { message?: string } | null)?.message));
      if (!pendingLimit || attempt === 4) return reply;
      await new Promise((done) => setTimeout(done, 200 * (attempt + 1)));
    }
  }

  // Fetches the schema at `path`: from the local cache for a peer with an
  // advertised hash (DESIGN.md §7.2), else from the node, in pieces when it
  // is too large for one response.
  async fetchSchema(path: string, depth: number): Promise<boolean> {
    const remote = remoteOf(this.root, path);
    const hash = remote?.stub.schema;
    const cacheKey = hash && `tesserui:schema:${location.origin}:${hash}:${path.slice(remote!.path.length) || '/'}:${depth}`;
    if (cacheKey) {
      const cached = storageGet(cacheKey);
      if (cached) {
        this.merge(path, JSON.parse(cached));
        return true;
      }
    }
    const r = await this.ask({ op: 'get', path, view: 'schema', depth });
    if (r.status === 'too_large' && depth > 1) {
      if (!(await this.fetchSchema(path, 1))) return false;
      const s = this.schemaAt(path);
      const tree = s?.type === 'remote' ? s.tree : s;
      for (const [name, c] of Object.entries(tree?.children ?? {})) {
        if (c.type === 'object') await this.fetchSchema(joinPath(path, name), depth - 1);
      }
      return true;
    }
    if (r.status !== 'ok') {
      if (r.status !== 'timeout' && r.status !== 'disconnected') this.store.fail(path, r);
      return false;
    }
    this.merge(path, r.body as Schema);
    if (cacheKey) storageSet(cacheKey, JSON.stringify(r.body));
    return true;
  }

  // What the screen shows: subscriptions follow (DESIGN.md §7.3). `specs`
  // are the main ones (the page, or a view's groups); conditions outside
  // them and the stub of the peer being shown are added.
  show(items: Item[], specs: SubSpec[], at: string) {
    const store = this.store;
    store.visible = visiblePaths({ cards: items.filter((i): i is Section => i.kind === 'section') });
    for (const i of items) store.visible.add(i.path);
    store.toastLabels.clear();
    store.charts.clear();
    const conds: Condition[] = [];
    const peers: string[] = [];
    walk(items, (i) => {
      if (i.visibleWhen) conds.push(...i.visibleWhen);
      if (i.enabledWhen) conds.push(...i.enabledWhen);
      if (i.kind === 'leaf') {
        if (i.toast) store.toastLabels.set(i.path, i.label);
        if (i.history) store.charts.set(i.path, i.history);
      } else if (i.kind === 'link' && i.remote && i.online && !this.schemaAt(i.path)?.tree) {
        peers.push(i.path);
      }
    });
    const all = [...specs];
    const outside = conds.map((c) => c.path).filter((p) => !specs.some((s) => isUnder(p, s.path)));
    if (outside.length) {
      const base = commonAncestor(outside.map(parentPath));
      all.push({ path: base, depth: Math.max(...outside.map((p) => segments(p).length - segments(base).length)) });
    }
    const remote = remoteOf(this.root, at);
    if (remote) {
      const name = remote.path.slice(remote.path.lastIndexOf('/') + 1);
      all.push({ path: parentPath(remote.path), keys: name, depth: 1 });
    }
    this.subs.want(all);
    // Peers' labels are in their own root schemas: fetch them, one by one.
    (async () => {
      for (const p of peers) await this.fetchSchema(p, 0);
    })();
  }

  showPage(page: Page) {
    this.show(page.cards, [{ path: page.path, keys: page.keys, depth: page.depth }], page.path);
  }
}

function walk(items: Item[], fn: (i: Item) => void) {
  for (const i of items) {
    fn(i);
    if (i.kind === 'section') walk([...i.items, ...i.advancedItems], fn);
  }
}

function hasLazyChildren(s: Schema, depth: number): boolean {
  if (s.type !== 'object') return false;
  if (!s.children) return true;
  if (depth <= 1) return false;
  return Object.values(s.children).some((c) => hasLazyChildren(c, depth - 1));
}

function collectRemotes(s: Schema, path: string, out: string[] = []): string[] {
  for (const [name, c] of Object.entries(s.children ?? {})) {
    const p = joinPath(path, name);
    if (c.type === 'remote') {
      out.push(p);
      if (c.tree) collectRemotes(c.tree, p, out);
    } else if (c.type === 'object') {
      collectRemotes(c, p, out);
    }
  }
  return out;
}

export type { Leaf };
