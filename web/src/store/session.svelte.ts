// One connection to a node (or a UI host and the peers behind it): the
// client, the schema tree fetched so far, the store and the subscriptions.

import { bleLink, EnvelopeClient, serialLink, webSocketLink } from '../client/envelope';
import { HttpClient } from '../client/http';
import { isObject } from '../client/json';
import { errorText, type Client, type ConnState, type Notification, type Reply, type Request } from '../client/types';
import type { Firmware } from '../flash/firmware';
import { toastKind, visiblePaths, type Item, type Leaf, type Page, type Section } from '../model/model';
import { isCut, isUnder, joinPath, mergeSchema, parentPath, rank, remoteOf, schemaAt, segments, type Level, type Schema } from '../model/schema';
import { relocate, type ViewPage } from '../model/views';
import { Store } from './store.svelte';
import { commonAncestor, Subscriptions, type SubSpec } from './subs';

export interface Config {
  api: string;
  ws: string | null;
  // serial and ble wait for the user to choose a device (DESIGN.md §9.7).
  transport: 'ws' | 'http' | 'serial' | 'ble';
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
  // The top bar: device label, connection state, sign-in.
  header?: boolean;
  // The navigation menu (DESIGN.md §6.3): one page per entry. Default: on
  // for the node's own page, off when embedded or without the header.
  menu?: boolean;
  // Nodes as tabs (DESIGN.md §6.5): the node, then each remote node of its
  // tree, each with its own menu. Default: on with the menu.
  tabs?: boolean;
  // 'hash' follows location.hash; 'memory' keeps the route to itself, for
  // UIs embedded in a page that owns the URL.
  routing?: 'hash' | 'memory';
  // A page that no node served (GitHub Pages, DESIGN.md §9.7): it connects
  // to the node the user picks, and remembers them.
  launcher?: boolean;
  // Firmware the launcher installs over USB (§9.7.1), with flash.js.
  firmware?: Firmware;
}

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private mode, full: the cache is only a cache
  }
}

// The nodes a launcher reached by address, most recent first.
const RECENT_KEY = 'tesserui:recent';
export interface RecentNode {
  api: string;
  // null: HTTP only; absent: the default (DESIGN.md §9.2).
  ws?: string | null;
  label: string;
}

export function recentNodes(): RecentNode[] {
  try {
    return JSON.parse(storageGet(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

// A node's part in the last "apply to all" (DESIGN.md §6.6).
export interface Applied {
  state: 'done' | 'absent' | 'offline' | 'refused';
  text?: string;
}

const LEVELS: Level[] = ['public', 'user', 'admin'];
const asLevel = (v: unknown): Level | null => (LEVELS.includes(v as Level) ? (v as Level) : null);

export class Session {
  state: ConnState = $state('connecting');
  // Bumped whenever the schema tree changes: models derive from it.
  schemaVersion = $state(0);
  // Each node's view pages, by its root ('/', or a remote node's path),
  // once read: [] when it has none.
  views: Record<string, ViewPage[]> = $state({});
  loaded = $state(false);
  needToken = $state(false);
  // This client's access level, when the node says (a `whoami` action); null
  // while unknown: nothing is disabled for it then.
  level: Level | null = $state(null);
  signedIn = $state(false);
  // Actions with ui.auth: "login" signs in with its object argument and
  // replies with a token; "whoami" replies with the client's level
  // (DESIGN.md §7.4).
  login: { path: string; schema: Schema } | null = $state(null);
  private whoamiPath: string | null = null;
  // Apply to all: the user's writes on one node go to every other node
  // (tab) at the same path below its root; each node's result, by its root.
  all = $state(false);
  applied: Record<string, Applied> = $state({});
  private applying = 0;
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

  // A launcher talks to many nodes from one origin: each has its token.
  private tokenKey: string;

  constructor(readonly config: Config) {
    this.tokenKey = 'tesserui:token' + (config.launcher ? ':' + this.apiUrl() : '');
    this.signedIn = !!this.token();
    this.store = new Store(() => this.client);
    this.store.onUnauthorized = () => (this.needToken = true);
    this.store.t = (text) => this.t(text);
    this.store.onWrite = (path, body) => this.all && this.applyAll(path, body);
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

  // The transport in use, once there is one: reactive, for the launcher.
  kind: Client['kind'] | undefined = $state();

  token(): string | null {
    return storageGet(this.tokenKey);
  }

  setToken(token: string | null) {
    storageSet(this.tokenKey, token);
    this.signedIn = !!token;
    this.needToken = false;
    this.store.toasts.show(this.t(token ? 'Signed in' : 'Signed out'), 'ok');
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
    this.views = {};
    for (const k of Object.keys(this.root)) delete (this.root as unknown as Record<string, unknown>)[k];
    this.root.type = 'object';
    this.schemaVersion++;
    if (this.line()) {
      this.authLine().then(async () => {
        await this.load();
        this.subs.renew(true);
      });
    } else if (this.client.kind === 'ws') {
      this.client.close();
      this.client.connect();
    } else {
      // The events stream opens again with the new token.
      this.load().then(() => this.subs.renew(true));
    }
  }

  start() {
    const t = this.config.transport;
    if (t === 'serial' || t === 'ble') return; // waits for useSerial() or useBle()
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
      let p: WebSocket;
      try {
        p = new WebSocket(this.wsUrl());
      } catch {
        return;
      }
      p.onopen = () => {
        p.close();
        const http = this.client;
        if (http?.kind !== 'http') return;
        this.start();
        http.close();
      };
      p.onerror = () => this.probe(Math.min(delay * 2, 60000));
    }, delay);
  }

  close() {
    this.subs.stop();
    this.client?.close();
  }

  // Web Serial: the port comes from a user gesture (navigator.serial.requestPort()).
  // Or a line the flasher already opened (§9.7.1).
  useSerial(port: Parameters<typeof serialLink>[0] | Client) {
    this.useLine('serial', 'request' in port ? port : new EnvelopeClient('serial', () => serialLink(port)));
  }

  // Web Bluetooth: the device too (navigator.bluetooth.requestDevice()).
  // Chrome keeps a device's id across visits: its token is kept by it.
  useBle(device: Parameters<typeof bleLink>[0]) {
    this.useLine(`ble:${device.id ?? device.name ?? ''}`, new EnvelopeClient('ble', () => bleLink(device)));
  }

  private useLine(key: string, client: Client) {
    this.tokenKey = `tesserui:token:${key}`;
    this.signedIn = !!this.token();
    this.use(client);
  }

  private line() {
    return this.client?.kind === 'serial' || this.client?.kind === 'ble';
  }

  // A line (serial, Bluetooth) presents its token in an auth envelope
  // (TesserAPI §10.4), after each connection and after signing in or out:
  // an empty token signs out. A token the node refuses comes back "public":
  // it is stale, and forgotten. Older firmware answers bad_request.
  private async authLine() {
    const token = this.token() ?? '';
    const r = await this.patient({ op: 'auth', path: '/', token });
    if (r.status === 'ok' && token && (r.body as { access?: string } | null)?.access === 'public') {
      storageSet(this.tokenKey, null);
      this.signedIn = false;
    }
  }

  // Files go over HTTP, raw and faster, wherever there is one; with none
  // (a line, or a serial port through the bridge, whose api is its /s), in
  // envelopes through the client returned here. So do those below a remote
  // node over a WebSocket: a gateway relaying one over HTTP serves nothing
  // else meanwhile, the WebSocket included (TesserAPI §14; DESIGN.md §4).
  fileClient(path: string): Client | null {
    const ws = this.client.kind === 'ws' && remoteOf(this.root, path);
    return ws || this.line() || /\/s$/.test(this.config.api) ? this.client : null;
  }

  // The URL of a path of the API over HTTP.
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
    this.kind = client.kind;
    client.onNotify((n) => this.notify(n));
    client.onState((s) => {
      if (this.client !== client) return;
      const wasDown = this.state !== 'open';
      this.state = s;
      if (s !== 'open' || !wasDown) return;
      // The banner said it was lost.
      if (this.loaded) this.store.toasts.show(this.t('Connected again'), 'ok');
      const go = () => (this.loaded ? this.subs.renew() : this.load());
      // A line forgets its token when it reconnects.
      if (this.line() && this.token()) this.authLine().then(go);
      else go();
    });
    client.connect();
  }

  // Opening a serial port resets most boards, which answer once booted (a
  // Wi-Fi node takes seconds): the first request is asked again, briefly,
  // until one answers.
  private async patient(r: Request): Promise<Reply> {
    let reply = await this.client.request(r, 1500);
    for (let i = 0; reply.status === 'timeout' && i < 40 && this.state === 'open'; i++) reply = await this.client.request(r, 1500);
    return reply;
  }

  private async load() {
    const h = await this.patient({ op: 'get', path: '/', view: 'hash' });
    this.rootHash = h.status === 'ok' && typeof h.body === 'string' ? h.body : null;
    if (!(await this.fetchSchema('/', 3))) return;
    this.findAuth();
    await this.whoami();
    // Views first: they decide the landing page.
    await this.loadViews('/');
    this.loaded = true;
    // A node reached by address goes to the top of the launcher's list.
    if (this.config.launcher && (this.client.kind === 'ws' || this.client.kind === 'http')) {
      const api = this.apiUrl();
      const label = this.root.label ?? new URL(api).host;
      const node: RecentNode = { api, ws: this.config.ws, label };
      storageSet(RECENT_KEY, JSON.stringify([node, ...recentNodes().filter((n) => n.api !== api)].slice(0, 6)));
    }
  }

  // A node's views (DESIGN.md §8), at its /_ui; a remote node's are read
  // through the gateway and moved below it.
  async loadViews(node: string) {
    const r = this.pageSchema(node)?.children?._ui ? await this.client.request({ op: 'get', path: joinPath(node, '_ui') }) : null;
    this.views[node] = r?.status === 'ok' && isObject(r.body) && Array.isArray(r.body.pages) ? relocate(r.body.pages as unknown as ViewPage[], node) : [];
  }

  // The remote nodes of the node's own tree, not those inside another
  // remote node: the UI's tabs after the node itself (DESIGN.md §6.5).
  nodes(): string[] {
    void this.schemaVersion;
    return this.remotePaths.filter((p) => !remoteOf(this.root, parentPath(p)));
  }

  // A node's label: its own, else its name (DESIGN.md §6.5).
  nodeLabel(path: string): string {
    const s = this.schemaAt(path);
    return (path === '/' ? this.root.label : (s?.label ?? s?.tree?.label)) ?? (path === '/' ? (this.config.title ?? 'TesserUI') : path.slice(path.lastIndexOf('/') + 1));
  }

  // Writes `rel`, a path below a node's root, on each node of this
  // connection but `except`, all at once; a gateway queues what's beyond its
  // pending slots (ask()). Offline nodes aren't sent to.
  async applyHere(rel: string, body: unknown, except?: string): Promise<[string, Applied][]> {
    const nodes = ['/', ...this.nodes()].filter((n) => n !== except);
    return Promise.all(
      nodes.map(async (n): Promise<[string, Applied]> => {
        const path = n === '/' ? rel : n + (rel === '/' ? '' : rel);
        let a: Applied = { state: 'offline' };
        if (!this.isOffline(path)) {
          const r = await this.ask({ op: 'set', path, body });
          a = r.status === 'ok' ? { state: 'done' } : r.status === 'not_found' ? { state: 'absent' } : { state: 'refused', text: errorText(r, this.store.t) };
        }
        this.applied[n] = a;
        return [this.nodeLabel(n), a];
      }),
    );
  }

  // After the last of a burst of writes (a drag) settles, one toast tells
  // which nodes didn't take it; the tabs show every node's result.
  private async applyAll(path: string, body: unknown) {
    const at = ++this.applying;
    const from = this.nodeRoot(path);
    const results = await this.applyHere(from === '/' ? path : path.slice(from.length) || '/', body, from);
    await new Promise((done) => setTimeout(done, 500));
    const failed = results.filter(([, a]) => a.state === 'refused' || a.state === 'offline');
    if (at !== this.applying || !failed.length) return;
    const done = results.filter(([, a]) => a.state === 'done').length;
    const text = [this.t('Applied to {n} of {total} other nodes', { n: done, total: results.length }), ...failed.map(([label, a]) => `${label}: ${a.text ?? this.t('offline')}`)];
    this.store.toasts.show(text.join('. '), 'warn', path);
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
    if (n.op === 'event') {
      this.event(n);
      return;
    }
    this.store.notify(n);
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

  // An event goes to the page's log when the page watches its path, unless
  // ui.hidden; with ui.toast, it is a toast wherever the user is (DESIGN.md
  // §7.8). One from elsewhere (the events subscription) may need its schema
  // read first.
  private async event(n: Notification) {
    let s = this.schemaAt(n.path);
    if (s?.ui?.hidden !== true && this.subs.covers(n.path)) this.store.notify(n);
    if (!s && (await this.ensure(parentPath(n.path), 1))) s = this.schemaAt(n.path);
    const kind = s?.type === 'event' ? toastKind(s.ui?.toast) : undefined;
    if (kind) this.store.toasts.show(n.body === null ? '' : typeof n.body === 'string' ? n.body : JSON.stringify(n.body), kind, n.path);
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
    // A list is a page of its own as a menu sub-entry (DESIGN.md §6.3).
    return tree?.children || s?.type === 'list' || s?.type === 'array' ? tree : undefined;
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
    if (known && known.type !== 'object' && known.type !== 'remote') return this.completeLists(path, 0);
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
    store.charts.clear();
    store.lines.clear();
    // Paths followed though not shown: conditions', option lists'.
    const followed: string[] = [];
    const peers: string[] = [];
    walk(items, (i) => {
      for (const c of [...(i.visibleWhen ?? []), ...(i.enabledWhen ?? [])]) followed.push(c.path);
      if (i.kind === 'leaf') {
        // An object's children (nodes under /peers): a stub's change, its
        // online state, comes in the object's value.
        if (i.optionsFrom) {
          const s = this.schemaAt(i.optionsFrom);
          const nodes = s?.type === 'object' ? Object.keys(s.children ?? {}).map((k) => joinPath(i.optionsFrom!, k)) : [];
          followed.push(...(nodes.length ? nodes : [i.optionsFrom]));
        }
        if (i.history) store.charts.set(i.path, i.history);
        if (i.lines) store.lines.set(i.path, i.lines);
      } else if (i.kind === 'link' && i.remote && i.online && !this.schemaAt(i.path)?.tree) {
        peers.push(i.path);
      }
    });
    const all = [...specs];
    const outside = followed.filter((p) => !specs.some((s) => isUnder(p, s.path)));
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
