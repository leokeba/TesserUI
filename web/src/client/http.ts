// HTTP fallback for nodes without a WebSocket (DESIGN.md §9.2): GET and PUT,
// no subscriptions (the store polls instead).

import { parse, stringify } from './json';
import { REQUEST_TIMEOUT_MS, type Client, type ConnState, type Notification, type Reply, type Request } from './types';

// An HTTPS page (GitHub Pages) reaching an http:// node on the local
// network: Chrome lets it through mixed content once the user allows local
// network access. Loopback is trustworthy already, and isn't "local".
const isLocal = (url: string) => location.protocol === 'https:' && /^http:/.test(url) && !/^http:\/\/(localhost|127\.|\[::1\])/.test(url);

export class HttpClient implements Client {
  readonly kind = 'http';
  readonly subscribes = false;
  private stateFns: ((s: ConnState) => void)[] = [];
  state: ConnState = 'connecting';

  constructor(
    private api: string,
    private token: () => string | null,
  ) {}

  onNotify(_fn: (n: Notification) => void) {}

  onState(fn: (s: ConnState) => void) {
    this.stateFns.push(fn);
  }

  private retry: ReturnType<typeof setTimeout> | undefined;

  private setState(s: ConnState) {
    // While the node doesn't answer, keep probing so that callers waiting for
    // 'open' (the first schema load) are woken up.
    if (s === 'down' && this.retry === undefined) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        this.connect();
      }, 2000);
    }
    if (s === this.state) return;
    this.state = s;
    for (const fn of this.stateFns) fn(s);
  }

  connect() {
    // There is no connection: the first request tells whether the node answers.
    this.request({ op: 'get', path: '/', depth: 0 });
  }

  close() {}

  async request(r: Request, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
    if (r.op === 'sub' || r.op === 'unsub') {
      return { status: 'not_allowed', body: { error: 'not_allowed', message: 'no subscriptions over HTTP' } };
    }
    const q = new URLSearchParams();
    if (r.op === 'get') {
      if (r.view) q.set('view', r.view);
      if (r.depth !== undefined) q.set('depth', String(r.depth));
      if (r.keys) q.set('keys', r.keys);
      if (r.exclude) q.set('exclude', r.exclude);
      if (r.remotes === false) q.set('remotes', 'false');
    }
    const headers: Record<string, string> = {};
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    const path = r.path === '/' ? '/' : r.path;
    const url = this.api + path + (q.size ? `?${q}` : '');
    const local = isLocal(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: r.op === 'get' ? 'GET' : 'PUT',
        headers,
        body: r.op === 'set' ? stringify(r.body ?? null) : undefined,
        signal: ctl.signal,
        ...(local && { targetAddressSpace: 'local' }),
      } as RequestInit);
      const text = await res.text();
      this.setState('open');
      const body = text ? parse(text) : null;
      if (res.ok) return { status: 'ok', body };
      const err = body as { error?: string } | null;
      return { status: err?.error ?? `http_${res.status}`, body };
    } catch {
      this.setState('down');
      const timedOut = ctl.signal.aborted;
      return { status: timedOut ? 'timeout' : 'disconnected', body: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
