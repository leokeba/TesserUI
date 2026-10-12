import { describe, expect, it } from 'vitest';
import { download, upload } from '../src/client/files';
import type { Client, Reply, Request } from '../src/client/types';

// A file node behind a line, as TesserAPI's FileSession serves it (§10.1.1):
// chunks of `chunk` bytes, the bytes before `received` skipped, the last
// download chunk sent again at its own offset. `lose` drops the reply to the
// envelopes it picks: the device has acted, the client times out.
class Device implements Client {
  kind = 'serial' as const;
  subscribes = true;
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
    const reply = this.handle(r);
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
    this.stored.push(...bytes.subarray(this.stored.length - offset));
    if (this.stored.length === this.expected) return { status: 'ok', body: this.final };
    return { status: 'ok', body: { received: this.stored.length } };
  }

  private chunkAt(offset: number, opening: boolean): Reply {
    const bytes = this.content.subarray(offset, offset + this.chunk);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    const head = opening ? { size: this.content.length, filename: 'backup.json', contentType: 'application/json', chunk: this.chunk } : {};
    return { status: 'ok', body: { ...head, offset, data: btoa(s), end: offset + this.chunk >= this.content.length } };
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
