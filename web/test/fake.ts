import type { Client, ConnState, Notification, Reply, Request } from '../src/client/types';

// A scripted client: requests are recorded, and answered by `answer` (or
// held until resolved by hand).
export class FakeClient implements Client {
  kind = 'ws' as const;
  subscribes = true;
  sent: Request[] = [];
  held: { req: Request; resolve: (r: Reply) => void }[] = [];
  answer: ((r: Request) => Reply | undefined) | null = null;
  private notifyFns: ((n: Notification) => void)[] = [];

  request(r: Request): Promise<Reply> {
    this.sent.push(r);
    const a = this.answer?.(r);
    if (a) return Promise.resolve(a);
    return new Promise((resolve) => this.held.push({ req: r, resolve }));
  }
  onNotify(fn: (n: Notification) => void) {
    this.notifyFns.push(fn);
  }
  onState(_fn: (s: ConnState) => void) {}
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
