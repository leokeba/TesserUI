import { describe, expect, it } from 'vitest';
import { bleLink, EnvelopeClient, serialLink } from '../src/client/envelope';

const enc = new TextEncoder();
const dec = new TextDecoder();
const flush = () => new Promise((r) => setTimeout(r, 0));

// A serial port whose device output the test pushes, recording what the
// page writes.
function fakePort() {
  let device!: ReadableStreamDefaultController<Uint8Array>;
  const written: string[] = [];
  const port = {
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    async open() {
      port.readable = new ReadableStream({ start: (c) => void (device = c) });
      port.writable = new WritableStream({ write: (chunk) => void written.push(dec.decode(chunk)) });
    },
    async close() {},
  };
  return { port, written, push: (text: string) => device.enqueue(enc.encode(text)) };
}

async function connected() {
  const f = fakePort();
  const client = new EnvelopeClient('serial', () => serialLink(f.port));
  client.connect();
  await flush();
  expect(client.state).toBe('open');
  return { ...f, client };
}

describe('envelopes over a line (DESIGN §9.2)', () => {
  it('takes whole lines, after reset noise, in pieces', async () => {
    const { client, push } = await connected();
    const reply = client.request({ op: 'get', path: '/a' });
    push('\xff\x00\r\n{"id":1,"sta');
    push('tus":"ok","body":18446744073709551615}\r\n');
    expect(await reply).toEqual({ status: 'ok', body: 18446744073709551615n });
  });

  it('reads log lines as log output, even when they hold an envelope', async () => {
    const { client, push } = await connected();
    const notes: unknown[] = [];
    client.onNotify((n) => notes.push(n.path));
    const reply = client.request({ op: 'get', path: '/a' }, 50);
    // An ESP log line ending in a JSON object, and one alone on a line
    // without a reply's body: neither resolves the pending request.
    push('\x1b[0;32mI (42) app: sent {"id":1,"status":"ok","body":"log"}\x1b[0m\n');
    push('I (43) app: {"op":"change","path":"/log","body":1}\n');
    push('{"id":1,"status":"ok"}\n');
    expect((await reply).status).toBe('timeout');
    push('{"op":"change","path":"/b","body":2}\n');
    await flush();
    expect(notes).toEqual(['/b']);
  });
});

// A Nordic UART device whose RX writes fail while `failing` says so,
// recording each write, and whether the page dropped the connection.
function fakeBle() {
  const writes: string[] = [];
  const f = { writes, failing: (_: string) => false, dropped: false };
  const tx = Object.assign(new EventTarget(), { startNotifications: async () => tx });
  const rx = {
    async writeValueWithResponse(chunk: Uint8Array) {
      const text = dec.decode(chunk);
      if (f.failing(text)) throw new Error('GATT operation failed');
      writes.push(text);
    },
  };
  // One object as both characteristics, as the types want.
  const service = { getCharacteristic: async () => Object.assign(tx, rx) };
  const device = Object.assign(new EventTarget(), {
    gatt: { connect: async () => ({ getPrimaryService: async () => service }), disconnect: () => void (f.dropped = true) },
  });
  return { f, device };
}

describe('envelopes over Bluetooth (DESIGN §9.2)', () => {
  async function connected() {
    const b = fakeBle();
    const client = new EnvelopeClient('ble', () => bleLink(b.device));
    client.connect();
    await flush();
    expect(client.state).toBe('open');
    return { ...b, client };
  }

  it('ends a line it failed to write, and fails its request at once', async () => {
    const { client, f } = await connected();
    // A long message: its second chunk fails.
    f.failing = (text) => text.startsWith('x');
    const failed = await client.request({ op: 'set', path: '/a', body: 'x'.repeat(1000) });
    expect(failed.status).toBe('disconnected');
    expect(f.writes.length).toBe(2);
    expect(f.writes[0]).toMatch(/^\{"id":1,/);
    expect(f.writes[1]).toBe('\n');
    // The next envelope goes whole, on a line of its own.
    f.failing = () => false;
    void client.request({ op: 'get', path: '/b' });
    await flush();
    expect(f.writes[2]).toBe('{"id":2,"op":"get","path":"/b"}\n');
    expect(f.dropped).toBe(false);
  });

  it('drops the link when even the newline fails', async () => {
    const { client, f } = await connected();
    f.failing = () => true;
    expect((await client.request({ op: 'get', path: '/a' })).status).toBe('disconnected');
    await flush();
    expect(f.dropped).toBe(true);
  });
});
