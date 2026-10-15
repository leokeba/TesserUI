import type { Client, ConnState, Notification, Reply, Request } from '../src/client/types';

// A scripted client: requests are recorded, and answered by `answer` (or
// held until resolved by hand).
export class FakeClient implements Client {
  kind = 'ws' as const;
  subscribes = true;
  protocol?: number;
  features?: string[];
  sent: Request[] = [];
  held: { req: Request; resolve: (r: Reply) => void }[] = [];
  answer: ((r: Request) => Reply | undefined) | null = null;
  private notifyFns: ((n: Notification) => void)[] = [];

  request(r: Request): Promise<Reply> {
    this.sent.push(r);
    // A node predates view=info (protocol 1) unless the test says otherwise.
    const a = this.answer?.(r) ?? (r.view === 'info' ? { status: 'bad_request', body: { error: 'bad_request', message: 'view must be value, schema or hash' } } : undefined);
    if (a) return Promise.resolve(a);
    return new Promise((resolve) => this.held.push({ req: r, resolve }));
  }
  onNotify(fn: (n: Notification) => void) {
    this.notifyFns.push(fn);
  }
  private stateFns: ((s: ConnState) => void)[] = [];
  onState(fn: (s: ConnState) => void) {
    this.stateFns.push(fn);
  }
  // The link going down or opening (again).
  state(s: ConnState) {
    for (const fn of this.stateFns) fn(s);
  }
  connect() {}
  close() {}
  push(n: Notification) {
    for (const fn of this.notifyFns) fn(n);
  }
  // Answers the oldest held request.
  reply(status: string, body: unknown) {
    const h = this.held.shift();
    if (!h) throw new Error('no held request');
    h.resolve({ status, body });
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));
