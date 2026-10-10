// One connection to a node (or a UI host and the peers behind it): the
// client, the schema tree fetched so far, the store and the subscriptions.

import { EnvelopeClient, serialLink, webSocketLink } from '../client/envelope';
import { HttpClient } from '../client/http';
import { isObject } from '../client/json';
import { errorText, type Client, type ConnState, type Notification, type Reply, type Request } from '../client/types';
import type { Condition } from '../model/conditions';
import { visiblePaths, type Item, type Leaf, type Page, type Section } from '../model/model';
import { isCut, isUnder, joinPath, mergeSchema, parentPath, rank, remoteOf, schemaAt, segments, type Level, type Schema } from '../model/schema';
import type { ViewPage } from '../model/views';
import { Store } from './store.svelte';
import { commonAncestor, Subscriptions, type SubSpec } from './subs';

export interface Config {
  api: string;
  ws: string | null;
  transport: 'ws' | 'http' | 'serial';
  minVersion?: string;
  // The page title until the node's label is known.
  title?: string;
  // Module scripts defining custom elements (DESIGN.md §9.8).
  scripts?: string[];
  // CSS variables without their "--": {"accent": "#d97706"}.
  theme?: Record<string, string>;
  // The interface's own text, by its English text (DESIGN.md §9.10).
  strings?: Record<string, string>;
  // The path the UI starts from and doesn't go above (embedding a subtree).
  path?: string;
  // The top bar: device label, view pages, connection state.
  header?: boolean;
  // 'hash' follows location.hash; 'memory' keeps the route to itself, for
  // UIs embedded in a page that owns the URL.
  routing?: 'hash' | 'memory';
}

const TOKEN_KEY = 'tesserui:token';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode, full: the cache is only a cache
  }
}

const LEVELS: Level[] = ['public', 'user', 'admin'];
const asLevel = (v: unknown): Level | null => (LEVELS.includes(v as Level) ? (v as Level) : null);

export class Session {
  state: ConnState = $state('connecting');
  // Bumped whenever the schema tree changes: models derive from it.
  schemaVersion = $state(0);
  views: ViewPage[] | null = $state(null);
  loaded = $state(false);
  needToken = $state(false);
  // This client's access level, when the node says (a `whoami` action); null
  // while unknown: nothing is disabled for it then.
  level: Level | null = $state(null);
  signedIn = $state(!!storageGet(TOKEN_KEY));
  // Actions with ui.auth: "login" signs in with its object argument and
  // replies with a token; "whoami" replies with the client's level
  // (DESIGN.md §7.4).
  login: { path: string; schema: Schema } | null = $state(null);
  private whoamiPath: string | null = null;
  // The hash of the node's schema as this client reads it (view=hash), for
  // its schema cache; null when the node doesn't say, or once its tree
  // changed (a peer's stub).
  private rootHash: string | null = null;  // The node's own root, once known: its label names the device.
  root: Schema = { type: 'object' };
  store: Store;
  subs: Subscriptions;
  private client!: Client;
  private stubRefresh = new Map<string, ReturnType<typeof setTimeout>>();
  private remotePaths: string[] = [];

  constructor(readonly config: Config) {
    this.store = new Store(() => this.client);
    this.store.onUnauthorized = () => (this.needToken = true);
    this.store.t = (text) => this.t(text);
    this.subs = new Subscriptions(() => this.client, this.store);
    this.subs.childNames = (path) => {
      const s = this.schemaAt(path);
      return Object.keys((s?.type === 'remote' ? s.tree : s)?.children ?? {});
    };
  }

  // The interface's text, translated by config.strings; {name} in the text
  // is replaced by vars.name.
  t(text: string, vars?: Record<string, string | number>): string {
    const s = this.config.strings?.[text] ?? text;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  get kind() {
    return this.client?.kind;
  }

  token(): string | null {
    return storageGet(TOKEN_KEY);
  }

  setToken(token: string | null) {
    storageSet(TOKEN_KEY, token);
    this.signedIn = !!token;
    this.needToken = false;
    this.reload();
  }

  // Whether this client may change a node needing `need`.
  can(need: Level | undefined): boolean {
    return this.level === null || rank(this.level) >= rank(need);
  }

  // Signs in through the login action; returns an error text, or null.
  async signIn(values: Record<string, unknown>): Promise<string | null> {
    if (!this.login) return null;
    const r = await this.client.request({ op: 'set', path: this.login.path, body: values });
    if (r.status !== 'ok') return errorText(r, this.store.t);
    const body = r.body as { token?: unknown } | string;
    const token = typeof body === 'string' ? body : body?.token;
    if (typeof token !== 'string') return this.t('No token in the reply');
    this.setToken(token);
    return null;
  }

  signOut() {
    this.setToken(null);
  }

  // A new identity: what the node shows may differ, so the schema is read
  // again. The WebSocket authenticates on its handshake: it reconnects.
  private reload() {
    if (!this.client) return;
    this.loaded = false;
    for (const k of Object.keys(this.root)) delete (this.root as unknown as Record<string, unknown>)[k];
    this.root.type = 'object';
    this.schemaVersion++;
    if (this.client.kind === 'ws') {
      this.client.close();
      this.client.connect();
    } else {
      this.load();
    }
  }

  start() {
    if (this.config.transport === 'serial') return; // waits for useSerial()
    if (this.config.transport === 'http' || !this.config.ws) return this.use(this.httpClient());
    const ws = new EnvelopeClient('ws', () => webSocketLink(this.wsUrl()));
    // A node without enableWebSocket(), or one that wasn't reachable yet
    // (restarting): fall back to HTTP, and switch back once a WebSocket opens.
    ws.onState((s) => {
      if (s === 'down' && ws.opened === 0 && this.client === ws) {
        // Switch first: closing emits 'down' again.
        this.use(this.httpClient());
        ws.close();
        this.probe(5000);
      }
    });
    this.use(ws);
  }

  private probe(delay: number) {
    setTimeout(() => {
      if (this.client?.kind !== 'http') return;
      const p = new WebSocket(this.wsUrl());
      p.onopen = () => {
        p.close();
        if (this.client?.kind === 'http') this.start();
      };
      p.onerror = () => this.probe(Math.min(delay * 2, 60000));
    }, delay);
  }

  close() {
    this.subs.stop();
    this.client?.close();
  }

  // Web Serial: the port comes from a user gesture (navigator.serial.requestPort()).
  useSerial(port: Parameters<typeof serialLink>[0]) {
    this.use(new EnvelopeClient('serial', () => serialLink(port)));
  }

  // The URL of a path of the API over HTTP: files go there whatever the
  // transport (DESIGN.md §4).
  apiUrl(path = '') {
    return new URL(this.config.api, location.href).href.replace(/\/$/, '') + path;
  }

  private httpClient() {
    return new HttpClient(this.apiUrl(), () => this.token());
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
    const h = await this.ask({ op: 'get', path: '/', view: 'hash' });
    this.rootHash = h.status === 'ok' && typeof h.body === 'string' ? h.body : null;
    if (!(await this.fetchSchema('/', 3))) return;
    this.findAuth();
    await this.whoami();
    // Views first: they decide the landing page.
    const ui = this.root.children?._ui;
    if (ui?.type === 'custom') {
      const r = await this.client.request({ op: 'get', path: '/_ui' });
      if (r.status === 'ok' && isObject(r.body) && Array.isArray(r.body.pages)) this.views = r.body.pages as unknown as ViewPage[];
    }
    this.loaded = true;
  }

  private findAuth() {
    this.login = null;
    this.whoamiPath = null;
    const walk = (s: Schema, path: string) => {
      for (const [name, c] of Object.entries(s.children ?? {})) {
        const p = joinPath(path, name);
        if (c.type === 'object') walk(c, p);
        else if (c.type === 'action' && c.ui?.auth === 'login') this.login = { path: p, schema: c };
        else if (c.type === 'action' && c.ui?.auth === 'whoami') this.whoamiPath = p;
      }
    };
    walk(this.root, '/');
  }

  private async whoami() {
    this.level = null;
    if (!this.whoamiPath) return;
    const r = await this.client.request({ op: 'set', path: this.whoamiPath, body: null });
    if (r.status === 'ok') this.level = asLevel(isObject(r.body) ? r.body.access : r.body);
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
    this.rootHash = null;
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

  // Makes sure the schema at `path` is known `depth` levels down, with the
  // lists there in full.
  async ensure(path: string, depth = 3): Promise<boolean> {
    const known = this.schemaAt(path);
    if (known && known.type !== 'object' && known.type !== 'remote') return true;
    if (this.pageSchema(path)) {
      const s = this.schemaAt(path)!;
      if (!hasLazyChildren(s.type === 'remote' ? s.tree! : s, depth)) return this.completeLists(path, depth);
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
    return (await this.fetchSchema(path, depth)) && this.completeLists(path, depth);
  }

  // A table needs its list's whole element schema, which depth may have cut
  // (a list at the limit has no items): such lists are fetched on their own.
  private async completeLists(path: string, depth: number): Promise<boolean> {
    const cut: string[] = [];
    const find = (s: Schema | undefined, p: string, left: number) => {
      if (!s) return;
      if (s.type === 'list' || s.type === 'array') {
        if (isCut(s)) cut.push(p);
      } else if (s.type === 'object' && left > 0) {
        for (const [name, c] of Object.entries(s.children ?? {})) find(c, joinPath(p, name), left - 1);
      }
    };
    const s = this.schemaAt(path);
    find(s?.type === 'remote' ? s.tree : s, path, depth);
    for (const p of cut) await this.fetchSchema(p, 16);
    return true;
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

  // Fetches the schema at `path`: from the local cache while its node's hash
  // holds (a peer's advertised one, else the node's view=hash; DESIGN.md
  // §7.2), else from the node, in pieces when it is too large for one
  // response.
  async fetchSchema(path: string, depth: number): Promise<boolean> {
    const remote = remoteOf(this.root, path);
    const hash = remote ? remote.stub.schema : this.rootHash;
    const cacheKey = hash && `tesserui:schema:${location.origin}:${hash}:${path.slice(remote?.path.length ?? 0) || '/'}:${depth}`;
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
    const depth = Number.isFinite(page.depth) ? page.depth : undefined;
    this.show(page.cards, [{ path: page.path, keys: page.keys, depth }], page.path);
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
