import { describe, expect, it, vi } from 'vitest';
import { crc32, download, upload } from '../src/client/files';
import type { Client, Reply, Request } from '../src/client/types';

// A file node behind a line, as TesserAPI's FileSession serves it (§10.1.1):
// chunks of `chunk` bytes, the bytes before `received` skipped, the last
// download chunk sent again at its own offset. `lose` drops the reply to the
// envelopes it picks: the device has acted, the client times out. `cut`
// loses four base64 characters of the envelopes it picks (an upload's on
// the way in, a download's reply on the way out), which still decode.
// With the crc32 feature, the device checks and gives each chunk's.
class Device implements Client {
  kind = 'serial' as const;
  subscribes = true;
  features?: string[];
  cut: (r: Request, n: number) => boolean = () => false;
  // Short of memory: takes half of each chunk's new bytes, and refuses the
  // completing chunk `refuse` times (busy).
  half = false;
  refuse = 0;
  sent: Request[] = [];
  stored: number[] = [];
  expected = 0;
  position = 0;
  last = -1;
  lose: (r: Request, n: number) => boolean = () => false;
  final: unknown = { ok: true };
  constructor(
    public content: Uint8Array,
    public chunk = 4,
  ) {}

  async request(r: Request): Promise<Reply> {
    this.sent.push(r);
    const cut = this.cut(r, this.sent.length);
    const reply = this.handle(cut && r.data ? { ...r, data: r.data.slice(4) } : r);
    if (cut && r.op === 'download') (reply.body as { data: string }).data = (reply.body as { data: string }).data.slice(4);
    return this.lose(r, this.sent.length) ? { status: 'timeout', body: null } : reply;
  }

  private handle(r: Request): Reply {
    const offset = r.offset ?? 0;
    if (r.op === 'download') {
      if (offset === 0) this.position = 0;
      else if (offset === this.last) return this.chunkAt(offset, offset === 0);
      else if (offset !== this.position) return { status: 'bad_request', body: { error: 'bad_request', message: `offset must be ${this.position}` } };
      this.last = offset;
      this.position = Math.min(offset + this.chunk, this.content.length);
      return this.chunkAt(offset, offset === 0);
    }
    if (r.size !== undefined) {
      this.expected = r.size;
      this.stored = [];
      if (!r.data) return { status: 'ok', body: r.size ? { received: 0, chunk: this.chunk } : this.final };
    }
    if (offset > this.stored.length) return { status: 'bad_request', body: { error: 'bad_request' } };
    const bytes = Uint8Array.from(atob(r.data ?? ''), (c) => c.charCodeAt(0));
    if (typeof r.crc32 === 'number' && r.crc32 !== crc32(bytes)) return { status: 'bad_request', body: { error: 'bad_request', reason: 'checksum' } };
    let fresh = bytes.subarray(this.stored.length - offset);
    if (this.stored.length + fresh.length === this.expected && this.refuse-- > 0) return { status: 'busy', body: { error: 'busy', reason: 'low_memory' } };
    if (this.half && this.stored.length + fresh.length < this.expected) fresh = fresh.subarray(0, Math.ceil(fresh.length / 2));
    this.stored.push(...fresh);
    if (this.stored.length === this.expected) return { status: 'ok', body: this.final };
    return { status: 'ok', body: { received: this.stored.length } };
  }

  private chunkAt(offset: number, opening: boolean): Reply {
    const bytes = this.content.subarray(offset, offset + this.chunk);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    const head = opening ? { size: this.content.length, filename: 'backup.json', contentType: 'application/json', chunk: this.chunk } : {};
    const sum = this.features && { crc32: crc32(bytes) };
    return { status: 'ok', body: { ...head, offset, data: btoa(s), ...sum, end: offset + this.chunk >= this.content.length } };
  }

  onNotify() {}
  onState() {}
  connect() {}
  close() {}
}

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37) & 0xff);

describe('downloads in envelopes', () => {
  it('follows the offsets, with the name, type and progress', async () => {
    const d = new Device(bytes(10));
    const seen: number[] = [];
    const r = await download(d, '/sys/backup', (f) => seen.push(f));
    expect(r.status).toBe('ok');
    const f = r.body as File;
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(bytes(10));
    expect([f.name, f.type]).toEqual(['backup.json', 'application/json']);
    expect(d.sent.map((s) => s.offset)).toEqual([0, 4, 8]);
    expect(seen).toEqual([0.4, 0.8, 1]);
  });

  it('asks a chunk again when its reply is lost', async () => {
    const d = new Device(bytes(10));
    d.lose = (r, n) => r.offset === 4 && n === 2;
    const r = await download(d, '/sys/backup', () => {});
    expect(new Uint8Array(await (r.body as File).arrayBuffer())).toEqual(bytes(10));
    expect(d.sent.map((s) => s.offset)).toEqual([0, 4, 4, 8]);
  });

  it('gives up after four tries, and passes errors on', async () => {
    const d = new Device(bytes(10));
    d.lose = () => true;
    expect((await download(d, '/f', () => {})).status).toBe('timeout');
    expect(d.sent).toHaveLength(4);
    const refused = Object.assign(new Device(bytes(10)), { request: async () => ({ status: 'not_allowed', body: { error: 'not_allowed', message: 'not a file' } }) });
    expect(await download(refused, '/f', () => {})).toEqual({ status: 'not_allowed', body: { error: 'not_allowed', message: 'not a file' } });
  });

  it('gives up on a device that stops sending the download', async () => {
    // Chunks of nothing, never the last.
    const d = new Device(bytes(10), 0);
    const r = await download(d, '/f', () => {});
    expect(r.status).toBe('internal');
    expect(d.sent).toHaveLength(3);
  });
});

describe('uploads in envelopes', () => {
  const file = (n: number) => new File([bytes(n)], 'fw.bin');

  it('opens with the size and name, then sends chunks from received', async () => {
    const d = new Device(new Uint8Array(), 4);
    const seen: number[] = [];
    const r = await upload(d, '/sys/firmware', file(10), (f) => seen.push(f));
    expect(r).toEqual({ status: 'ok', body: { ok: true } });
    expect(d.stored).toEqual([...bytes(10)]);
    expect(d.sent[0]).toEqual({ op: 'upload', path: '/sys/firmware', size: 10, filename: 'fw.bin' });
    expect(d.sent.slice(1).map((s) => s.offset)).toEqual([0, 4, 8]);
    expect(seen).toEqual([0.4, 0.8]);
  });

  it('sends a chunk again when its reply is lost, written once', async () => {
    const d = new Device(new Uint8Array(), 4);
    d.lose = (r, n) => r.offset === 4 && n === 3;
    expect((await upload(d, '/f', file(10), () => {})).status).toBe('ok');
    expect(d.stored).toEqual([...bytes(10)]);
    expect(d.sent.slice(1).map((s) => s.offset)).toEqual([0, 4, 4, 8]);
  });

  // A gateway relaying the chunk to a remote node: the try given up on is
  // still on its way, and the next is busy until its reply comes.
  it('waits while a gateway is busy relaying, then sends again', async () => {
    const d = new Device(new Uint8Array(), 4);
    let busy = 1;
    const relayed = Object.assign(d, {
      request: async (r: Request): Promise<Reply> =>
        r.offset === 4 && busy-- > 0 ? { status: 'busy', body: { error: 'busy', message: 'the last chunk is still on its way' } } : Device.prototype.request.call(d, r),
    });
    vi.useFakeTimers();
    const done = upload(relayed, '/peers/lamp/f', file(10), () => {});
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect((await done).status).toBe('ok');
    expect(d.stored).toEqual([...bytes(10)]);
  });

  // TesserAPI d70e8f3: a device short of memory takes part of a chunk, and
  // takes the completing one whole or refuses it.
  it('goes on from received when the device takes part of each chunk', async () => {
    const d = Object.assign(new Device(new Uint8Array(), 8), { half: true, refuse: 2, features: ['crc32'] });
    const seen: number[] = [];
    vi.useFakeTimers();
    const done = upload(d, '/sys/firmware', file(20), (f) => seen.push(f));
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(await done).toEqual({ status: 'ok', body: { ok: true } });
    expect(d.stored).toEqual([...bytes(20)]);
    expect(d.sent.slice(1).map((s) => [s.offset, atob(s.data!).length])).toEqual([
      [0, 8],
      [4, 8],
      [8, 8],
      [12, 8],
      [12, 8],
      [12, 8],
    ]);
    expect(seen).toEqual([0.2, 0.4, 0.6]);
  });

  it('gives up on a device that stops taking the upload', async () => {
    const d = new Device(new Uint8Array(), 4);
    const stalled = Object.assign(d, {
      request: async (r: Request): Promise<Reply> => (r.offset === 4 ? (d.sent.push(r), { status: 'ok', body: { received: 4 } }) : Device.prototype.request.call(d, r)),
    });
    expect(await upload(stalled, '/f', file(10), () => {})).toEqual({
      status: 'internal',
      body: { error: 'internal', message: 'the device stopped taking the upload' },
    });
    expect(d.sent.slice(1).map((s) => s.offset)).toEqual([0, 4, 4, 4]);
  });

  it("doesn't ask the opening or the last chunk again", async () => {
    const d = new Device(new Uint8Array(), 4);
    d.lose = (r) => r.size !== undefined;
    expect((await upload(d, '/f', file(10), () => {})).status).toBe('timeout');
    expect(d.sent).toHaveLength(1);
    const e = new Device(new Uint8Array(), 4);
    e.lose = (r) => r.offset === 8;
    expect((await upload(e, '/f', file(10), () => {})).status).toBe('timeout');
    expect(e.sent.slice(1).map((s) => s.offset)).toEqual([0, 4, 8]);
  });

  it("an empty file's opening is its last chunk", async () => {
    const d = new Device(new Uint8Array(), 4);
    expect(await upload(d, '/f', file(0), () => {})).toEqual({ status: 'ok', body: { ok: true } });
    expect(d.sent).toHaveLength(1);
  });
});

// TesserAPI §10.1.1: a serial line can lose bytes and still be base64.
describe('checksums (feature crc32)', () => {
  const file = (n: number) => new File([bytes(n)], 'fw.bin');
  const device = (content: Uint8Array) => Object.assign(new Device(content, 6), { features: ['crc32'] });

  it("computes zlib's CRC-32", () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('sends each upload chunk with its own, and again when it arrives damaged', async () => {
    const d = device(new Uint8Array());
    // The second chunk and the last lose bytes on the way.
    d.cut = (r, n) => !!r.data && (n === 3 || r.offset === 12) && d.sent.filter((x) => x.offset === r.offset).length === 1;
    expect((await upload(d, '/f', file(16), () => {})).status).toBe('ok');
    expect(d.stored).toEqual([...bytes(16)]);
    expect(d.sent.slice(1).map((s) => s.offset)).toEqual([0, 6, 6, 12, 12]);
    for (const s of d.sent.slice(1)) expect(s.crc32).toBe(crc32(bytes(16).subarray(s.offset!, s.offset! + 6)));
  });

  it("sends a line the device lost bytes of again at once, the opening too", async () => {
    const d = device(new Uint8Array());
    // The opening and the second chunk, once each.
    const lost = new Set<string>();
    const lossy = Object.assign(d, {
      request: async (r: Request): Promise<Reply> => {
        const which = r.size !== undefined ? 'open' : String(r.offset);
        if (!['open', '6'].includes(which) || lost.has(which)) return Device.prototype.request.call(d, r);
        lost.add(which);
        d.sent.push(r);
        return { status: 'busy', body: { error: 'busy', reason: 'line_overrun' } };
      },
    });
    expect((await upload(lossy, '/f', file(10), () => {})).status).toBe('ok');
    expect(d.stored).toEqual([...bytes(10)]);
    expect(d.sent.map((s) => s.offset ?? 'open')).toEqual(['open', 'open', 0, 6, 6]);
  });

  it('asks for download chunks with theirs, and again when one arrives damaged', async () => {
    const d = device(bytes(16));
    d.cut = (_, n) => n === 2;
    const r = await download(d, '/f', () => {});
    expect(new Uint8Array(await (r.body as File).arrayBuffer())).toEqual(bytes(16));
    expect(d.sent.map((s) => [s.offset, s.crc32])).toEqual([
      [0, true],
      [6, true],
      [6, true],
      [12, true],
    ]);
  });

  it('gives up on a chunk damaged five times', async () => {
    const d = device(bytes(16));
    d.cut = () => true;
    expect(await download(d, '/f', () => {})).toMatchObject({ status: 'bad_request', body: { reason: 'checksum' } });
    expect(d.sent).toHaveLength(5);
  });

  it("sends none to a node without the feature, and still asks again for a chunk that doesn't decode", async () => {
    const up = new Device(new Uint8Array(), 6);
    expect((await upload(up, '/f', file(10), () => {})).status).toBe('ok');
    expect(up.sent.some((s) => 'crc32' in s)).toBe(false);
    const down = new Device(bytes(10), 6);
    const broken = Object.assign(down, {
      request: async (r: Request): Promise<Reply> => {
        const reply = await Device.prototype.request.call(down, r);
        if (down.sent.length === 1) (reply.body as { data: string }).data += '=';
        return reply;
      },
    });
    const r = await download(broken, '/f', () => {});
    expect(new Uint8Array(await (r.body as File).arrayBuffer())).toEqual(bytes(10));
    expect(down.sent.some((s) => 'crc32' in s)).toBe(false);
    expect(down.sent.map((s) => s.offset)).toEqual([0, 0, 6]);
  });
});
