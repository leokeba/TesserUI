import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/client/http';
import type { Notification } from '../src/client/types';
import { EVENTS } from '../src/store/subs';

// A streamed response whose chunks are pushed by the test.
function streamed() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  const enc = new TextEncoder();
  return {
    res: new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    push: (text: string) => ctl.enqueue(enc.encode(text)),
    end: () => ctl.close(),
  };
}

describe('HTTP: the events stream', () => {
  let calls: { url: string; init: RequestInit }[];
  let answers: (() => Response | Promise<Response>)[];
  const flush = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('location', new URL('http://node.local/'));
    calls = [];
    answers = [];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      calls.push({ url, init });
      init.signal?.addEventListener('abort', () => calls.push({ url: 'aborted', init }));
      // Only streams are answered: the client's own probes fail.
      const a = url.includes('?sub') ? answers.shift() : undefined;
      return a ? Promise.resolve(a()) : Promise.reject(new Error('offline'));
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens a streamed GET and reads one notification per line', async () => {
    const s = streamed();
    answers.push(() => s.res);
    const c = new HttpClient('http://node.local/api', () => 'tok');
    const got: Notification[] = [];
    c.onNotify((n) => got.push(n));
    expect(await c.request(EVENTS)).toEqual({ status: 'ok', body: null });
    expect(calls[0].url).toBe('http://node.local/api/?sub&interval=60000&changes=false&snapshot=false');
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    // Lines split across chunks, keepalives, 64-bit values.
    s.push('{"op":"event","path":"/motor/homed","body":null}\n\n{"op":"event","pa');
    s.push('th":"/count","body":18446744073709551615}\n');
    await flush();
    expect(got).toEqual([
      { op: 'event', path: '/motor/homed', body: null },
      { op: 'event', path: '/count', body: 18446744073709551615n },
    ]);
  });

  it('takes a plain JSON answer for firmware without streams', async () => {
    answers.push(() => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }));
    const c = new HttpClient('http://node.local/api', () => null);
    expect((await c.request(EVENTS)).status).toBe('not_allowed');
  });

  it('takes it for an error from a node at protocol 2, which has streams', async () => {
    answers.push(() => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }));
    const c = new HttpClient('http://node.local/api', () => null);
    c.protocol = 2;
    expect((await c.request(EVENTS)).status).toBe('internal');
  });

  it("passes the node's refusal on", async () => {
    answers.push(() => new Response('{"error":"busy","message":"too many subscriptions"}', { status: 503 }));
    const c = new HttpClient('http://node.local/api', () => null);
    expect((await c.request(EVENTS)).status).toBe('busy');
  });

  it('opens again when the stream ends or falls silent, until unsubscribed', async () => {
    const a = streamed();
    answers.push(() => a.res);
    const c = new HttpClient('http://node.local/api', () => null);
    await c.request(EVENTS);
    a.end();
    await flush();
    // The node is away a second, then answers.
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((x) => x.url.includes('?sub')).length).toBe(2);
    answers.push(() => streamed().res);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls.filter((x) => x.url.includes('?sub')).length).toBe(3);
    // Silence: dropped and opened again.
    answers.push(() => streamed().res);
    await vi.advanceTimersByTimeAsync(40000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter((x) => x.url.includes('?sub')).length).toBe(4);
    await c.request({ op: 'unsub', path: '/' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(calls.filter((x) => x.url.includes('?sub')).length).toBe(4);
  });

  it('replaces its stream on a new sub', async () => {
    const a = streamed();
    const b = streamed();
    answers.push(
      () => a.res,
      () => b.res,
    );
    const c = new HttpClient('http://node.local/api', () => null);
    const got: unknown[] = [];
    c.onNotify((n) => got.push(n.path));
    await c.request(EVENTS);
    await c.request(EVENTS);
    expect(calls.map((x) => x.url).filter((u) => u === 'aborted').length).toBe(1);
    b.push('{"op":"event","path":"/b","body":1}\n');
    await flush();
    expect(got).toEqual(['/b']);
    expect(calls.filter((x) => x.url.includes('?sub')).length).toBe(2);
  });
});
