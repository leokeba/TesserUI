// Envelope client over a message link: WebSocket, Web Serial or Web Bluetooth
// (DESIGN.md §9.2). Numeric ids, a timeout per request, reconnection with backoff.

import { isObject, parse, stringify } from './json';
import { REQUEST_TIMEOUT_MS, type Client, type ConnState, type Notification, type Reply, type Request } from './types';

export interface Link {
  // Resolves once the link can send; onClose fires once, whenever it ends.
  open(onMessage: (text: string) => void, onClose: () => void): Promise<void>;
  // May return a promise, rejected when the message couldn't be written.
  send(text: string): void | Promise<void>;
  close(): void;
}

const BACKOFF_MS = [500, 1000, 2000, 5000];
// A WebSocket silent for two of these is asked for the node's view=info,
// and dropped after two more: one to a node that lost power may never
// close (DESIGN.md §7.5).
const QUIET_MS = 10000;

interface Pending {
  resolve: (r: Reply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EnvelopeClient implements Client {
  readonly subscribes = true;
  private link: Link | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notify: ((n: Notification) => void)[] = [];
  private stateFns: ((s: ConnState) => void)[] = [];
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  // Checks of the WebSocket since its last message.
  private silent = 0;
  state: ConnState = 'down';
  // How many times the link opened, so callers can tell a first failure.
  opened = 0;

  constructor(
    readonly kind: 'ws' | 'serial' | 'ble',
    private makeLink: () => Link,
  ) {}

  onNotify(fn: (n: Notification) => void) {
    this.notify.push(fn);
  }

  onState(fn: (s: ConnState) => void) {
    this.stateFns.push(fn);
  }

  private setState(s: ConnState) {
    this.state = s;
    for (const fn of this.stateFns) fn(s);
  }

  connect() {
    this.closed = false;
    clearTimeout(this.retry);
    this.setState('connecting');
    const link = this.makeLink();
    this.link = link;
    link.open(
      (text) => this.receive(text),
      () => this.lost(link),
    ).then(
      () => {
        if (this.link !== link) return;
        this.attempt = 0;
        this.opened++;
        this.silent = 0;
        this.setState('open');
        if (this.kind !== 'ws') return;
        const quiet = setInterval(() => {
          if (this.link !== link) clearInterval(quiet);
          else if (++this.silent > 3) this.lost(link), link.close();
          else if (this.silent > 1) this.request({ op: 'get', path: '/', view: 'info' });
        }, QUIET_MS);
      },
      () => {},
    );
  }

  private lost(link: Link) {
    if (this.link !== link) return;
    this.link = null;
    this.failAll();
    this.setState('down');
    if (!this.closed) this.retry = setTimeout(() => this.connect(), BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    const link = this.link;
    this.link = null;
    link?.close();
    this.failAll();
    this.setState('down');
  }

  request(r: Request, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
    return new Promise((resolve) => {
      if (!this.link || this.state !== 'open') return resolve({ status: 'disconnected', body: null });
      const id = this.nextId++;
      const timer = setTimeout(() => this.settle(id, { status: 'timeout', body: { error: 'timeout', message: 'no reply' } }), timeoutMs);
      this.pending.set(id, { resolve, timer });
      const env: Record<string, unknown> = { id, ...r };
      if (r.body === undefined) delete env.body;
      // A message the link couldn't write fails at once.
      this.link.send(stringify(env))?.catch(() => this.settle(id, { status: 'disconnected', body: null }));
    });
  }

  private settle(id: number, r: Reply) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(r);
  }

  private receive(text: string) {
    this.silent = 0;
    let msg: unknown;
    try {
      msg = parse(text);
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    // A reply carries the id of a pending request, a status and a body, as
    // every TesserAPI reply does: a line that only looks like one is ignored.
    if (typeof msg.id === 'number' && typeof msg.status === 'string' && 'body' in msg) {
      this.settle(msg.id, { status: msg.status, body: msg.body });
    } else if ((msg.op === 'change' || msg.op === 'event') && typeof msg.path === 'string') {
      const n = msg as unknown as Notification;
      for (const fn of this.notify) fn(n);
    }
  }

  private failAll() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ status: 'disconnected', body: null });
    }
    this.pending.clear();
  }
}

export function webSocketLink(url: string): Link {
  let ws: WebSocket | null = null;
  return {
    open(onMessage, onClose) {
      return new Promise((resolve, reject) => {
        let done = false;
        const end = () => {
          if (done) return;
          done = true;
          reject(new Error('closed'));
          onClose();
        };
        // Throws on an HTTPS page for a ws:// URL (mixed content).
        try {
          ws = new WebSocket(url);
        } catch {
          return setTimeout(end);
        }
        ws.onopen = () => resolve();
        ws.onmessage = (e) => typeof e.data === 'string' && onMessage(e.data);
        ws.onclose = end;
        ws.onerror = () => ws?.close();
      });
    },
    send(text) {
      ws?.send(text);
    },
    close() {
      ws?.close();
    },
  };
}
