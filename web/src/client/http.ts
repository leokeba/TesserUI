// HTTP fallback for nodes without a WebSocket (DESIGN.md §9.2): GET and PUT;
// the store polls values. The events subscription is one streamed GET.

import { isObject, parse, stringify } from './json';
import { REQUEST_TIMEOUT_MS, type Client, type ConnState, type Notification, type Reply, type Request } from './types';

// An HTTPS page (GitHub Pages) reaching an http:// node on the local
// network: Chrome lets it through mixed content once the user allows local
// network access. Loopback is trustworthy already, and isn't "local".
const isLocal = (url: string) => location.protocol === 'https:' && /^http:/.test(url) && !/^http:\/\/(localhost|127\.|\[::1\])/.test(url);

// A tree path in a URL: each name percent-encoded, as a keyed list's keys
// (file names) may hold spaces, '#' or '?'. The node decodes the path.
export const urlPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// A file node's URL (DESIGN.md §4); an upload names the chosen file.
export const fileUrl = (api: string, path: string, filename?: string) =>
  api + urlPath(path) + (filename ? `?filename=${encodeURIComponent(filename)}` : '');

// A stream sends at least a newline every 15 s.
const SILENCE_MS = 40000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

export class HttpClient implements Client {
  readonly kind = 'http';
  readonly subscribes = false;
  protocol?: number;
  private stateFns: ((s: ConnState) => void)[] = [];
  private notify: ((n: Notification) => void)[] = [];
  // The stream of the one subscription, and a count of every sub and unsub,
  // so that a stream that ended doesn't reopen over a newer one.
  private stream: AbortController | null = null;
  private gen = 0;
  state: ConnState = 'connecting';

  constructor(
    private api: string,
    private token: () => string | null,
  ) {}

  onNotify(fn: (n: Notification) => void) {
    this.notify.push(fn);
  }

  onState(fn: (s: ConnState) => void) {
    this.stateFns.push(fn);
  }

  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  private setState(s: ConnState) {
    // While the node doesn't answer, keep probing so that callers waiting for
    // 'open' (the first schema load) are woken up; not once closed.
    if (s === 'down' && this.retry === undefined && !this.closed) {
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
    this.closed = false;
    this.request({ op: 'get', path: '/', depth: 0 });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.request({ op: 'unsub', path: '/' });
  }

  async request(r: Request, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
    if (r.op === 'sub' || r.op === 'unsub') {
      this.gen++;
      this.stream?.abort();
      this.stream = null;
      if (r.op === 'unsub') return { status: 'ok', body: null };
    }
    const q = new URLSearchParams();
    for (const k of ['view', 'depth', 'keys', 'exclude', 'interval', 'events', 'changes', 'snapshot'] as const) {
      if (r[k] !== undefined && r.op !== 'set') q.set(k, String(r[k]));
    }
    if (r.remotes === false) q.set('remotes', 'false');
    const headers: Record<string, string> = {};
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    const query = [...(r.op === 'sub' ? ['sub'] : []), ...(q.size ? [q] : [])].join('&');
    const url = this.api + urlPath(r.path) + (query ? `?${query}` : '');
    const local = isLocal(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    if (r.op === 'sub') this.stream = ctl;
    try {
      const res = await fetch(url, {
        method: r.op === 'set' ? 'PUT' : 'GET',
        headers,
        body: r.op === 'set' ? stringify(r.body ?? null) : undefined,
        signal: ctl.signal,
        ...(local && { targetAddressSpace: 'local' }),
      } as RequestInit);
      if (r.op === 'sub' && res.ok) {
        clearTimeout(timer);
        this.setState('open');
        // Firmware without streams answers the value: no subscription. From
        // protocol 2 on, every node has them: anything else is an error.
        if (!/ndjson/.test(res.headers.get('content-type') ?? '') || !res.body) {
          ctl.abort();
          return { status: this.protocol! > 1 ? 'internal' : 'not_allowed', body: null };
        }
        this.read(res.body, ctl, r);
        return { status: 'ok', body: null };
      }
      const text = await res.text();
      this.setState('open');
      const body = text ? parse(text) : null;
      if (res.ok) return { status: 'ok', body };
      const err = body as { error?: string } | null;
      return { status: err?.error ?? `http_${res.status}`, body };
    } catch {
      // A newer sub or unsub took over: that one answers for the stream.
      if (r.op === 'sub' && this.stream !== ctl) return { status: 'ok', body: null };
      this.setState('down');
      const timedOut = ctl.signal.aborted;
      return { status: timedOut ? 'timeout' : 'disconnected', body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  // One notification per line; a bare newline keeps the stream alive. A
  // stream that ends or falls silent opens again, later each time it fails.
  private async read(body: ReadableStream<Uint8Array>, ctl: AbortController, r: Request) {
    let gen = this.gen;
    const reader = body.getReader();
    ctl.signal.addEventListener('abort', () => reader.cancel().catch(() => {}));
    const dec = new TextDecoder();
    let buf = '';
    let silence: ReturnType<typeof setTimeout> | undefined;
    try {
      for (;;) {
        clearTimeout(silence);
        silence = setTimeout(() => ctl.abort(), SILENCE_MS);
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          let msg: unknown;
          try {
            msg = parse(line);
          } catch {
            continue;
          }
          if (isObject(msg) && (msg.op === 'change' || msg.op === 'event') && typeof msg.path === 'string') {
            for (const fn of this.notify) fn(msg as unknown as Notification);
          }
        }
      }
    } catch {
      // aborted, or the connection dropped
    }
    clearTimeout(silence);
    ctl.abort();
    for (let i = 0; this.gen === gen; i++) {
      await new Promise((res) => setTimeout(res, BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)]));
      if (this.gen !== gen) return;
      const opening = this.request(r);
      gen = this.gen;
      // Opened (that one reads on), or refused (no stream after all).
      if (!['timeout', 'disconnected'].includes((await opening).status)) return;
    }
  }
}
