// The schema tree of a session (DESIGN.md §7.2): what has been read of it,
// reading more (from the node, or the cache while its hash holds), and the
// remote nodes in it, whose stubs a change notification may say changed.
// Session builds on it with the connection that reads it.

import { parse, stringify } from '../client/json';
import { lowMemory, reason, type Client, type Reply, type Request } from '../client/types';
import { isCut, joinPath, mergeSchema, parentPath, remoteOf, schemaAt, segments, type Schema } from '../model/schema';
import type { Store } from './store.svelte';
import { CACHE, storageGet, storageSet } from './storage';

export abstract class Schemas {
  // Bumped whenever the schema tree changes: models derive from it.
  schemaVersion = $state(0);
  root: Schema = { type: 'object' };
  abstract store: Store;
  protected client!: Client;
  // The hash of the node's schema as this client reads it (view=info), for
  // its schema cache; null when the node doesn't say, or once its tree
  // changed (a peer's stub).
  protected rootHash: string | null = null;
  protected remotePaths: string[] = [];
  protected stubRefresh = new Map<string, ReturnType<typeof setTimeout>>();
  // Schema reads in flight, which callers share.
  private fetching = new Map<string, Promise<boolean>>();

  // The node the cache's entries belong to, as far as the page knows it.
  protected abstract cacheNode(): unknown[];

  // The remote nodes of the node's own tree, not those inside another
  // remote node: the UI's tabs after the node itself (DESIGN.md §6.5).
  nodes(): string[] {
    void this.schemaVersion;
    return this.remotePaths.filter((p) => !remoteOf(this.root, parentPath(p)));
  }

  protected refreshStub(path: string) {
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

  protected merge(path: string, fetched: Schema) {
    mergeSchema(this.root, path, fetched);
    this.remotePaths = collectRemotes(this.root, '/');
    this.schemaVersion++;
  }

  // Makes sure the schema at `path` is known `depth` levels down, with the
  // lists there in full. `quiet`: a failure isn't reported, since the
  // caller shows it (a view's item: "unavailable", DESIGN.md §7.8).
  async ensure(path: string, depth = 3, quiet = false): Promise<boolean> {
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
        if (!(await this.fetchSchema(p, 1, quiet))) return false;
      }
    }
    return (await this.fetchSchema(path, depth, quiet)) && this.completeLists(path, depth);
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
  // default: 4) and answers `busy` beyond: schema reads wait and retry. So
  // they do when the node has no memory for the reply (TesserAPI dba7c1f),
  // longer, unless `split`: the caller asks for less instead.
  async ask(r: Request, split = false): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      const reply = await this.client.request(r);
      const memory = !split && lowMemory(reply);
      const pendingLimit = reply.status === 'busy' && reason(reply) === 'pending_limit';
      if (!(pendingLimit || memory) || attempt === 4) return reply;
      await new Promise((done) => setTimeout(done, memory ? 500 * 2 ** attempt : 200 * (attempt + 1)));
    }
  }

  // Fetches the schema at `path`: from the local cache while its node's hash
  // holds (a peer's advertised one, else the node's view=hash; DESIGN.md
  // §7.2), else from the node, in pieces when it is too large for one
  // response. Entries are the node's own, by its address and identity (a
  // peer's: its gateway's, at its path): another node can't plant one by
  // answering with the same hash.
  fetchSchema(path: string, depth: number, quiet = false): Promise<boolean> {
    const k = path + ' ' + depth;
    let p = this.fetching.get(k);
    if (!p) this.fetching.set(k, (p = this.read(path, depth, quiet).finally(() => this.fetching.delete(k))));
    return p;
  }

  private async read(path: string, depth: number, quiet: boolean): Promise<boolean> {
    const remote = remoteOf(this.root, path);
    const hash = remote ? remote.stub.schema : this.rootHash;
    // One entry per node, path and depth, the hash it was read for before
    // the schema: a new hash replaces it.
    const cacheKey = hash && CACHE + JSON.stringify([...this.cacheNode(), remote?.path ?? '', path.slice(remote?.path.length ?? 0) || '/', depth]);
    const head = hash + '\n';
    const cached = cacheKey && storageGet(cacheKey);
    if (cached?.startsWith(head)) {
      try {
        this.merge(path, parse(cached.slice(head.length)) as Schema);
        return true;
      } catch {
        // a broken entry: read again
      }
    }
    const r = await this.ask({ op: 'get', path, view: 'schema', depth }, depth > 1);
    // Too large for a response, or for the node's memory: a level at a time.
    if ((r.status === 'too_large' || lowMemory(r)) && depth > 1) {
      if (!(await this.fetchSchema(path, 1, quiet))) return false;
      const s = this.schemaAt(path);
      const tree = s?.type === 'remote' ? s.tree : s;
      for (const [name, c] of Object.entries(tree?.children ?? {})) {
        if (c.type === 'object') await this.fetchSchema(joinPath(path, name), depth - 1, quiet);
      }
      return true;
    }
    if (r.status !== 'ok') {
      if (!quiet && r.status !== 'timeout' && r.status !== 'disconnected' && !lowMemory(r)) this.store.fail(path, r);
      return false;
    }
    this.merge(path, r.body as Schema);
    if (cacheKey) storageSet(cacheKey, head + stringify(r.body));
    return true;
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

