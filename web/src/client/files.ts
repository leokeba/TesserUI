// File transfers in envelopes (TesserAPI DESIGN.md §10.1.1), for clients
// with no HTTP (serial and Bluetooth lines, a bridge's serial port) and for
// files below a remote node over a WebSocket. One envelope per chunk, the
// bytes in base64. A chunk whose reply doesn't come is sent again at the
// same offset, which the device makes harmless. A node with the crc32
// feature checks each chunk's CRC-32, and gives its own: a serial line can
// lose bytes and still be base64.

import { DEFERRED_TIMEOUT_MS, reason, type Client, type Reply, type Request } from './types';

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

// CRC-32 (IEEE 802.3, zlib's crc32()).
let table: number[] | undefined;
export function crc32(bytes: Uint8Array): number {
  table ??= Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n;
  });
  let c = -1;
  for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Longer than a gateway relaying a chunk to a remote node tries it itself
// (three times its 3 s timeout, TesserAPI §14), after which it answers
// `timeout`.
const CHUNK_TIMEOUT_MS = 10000;

// Asked again while it times out, or a moment later while it is `busy`: a
// gateway still relaying the try given up on, or at its maxPending. Sent
// again too, up to five times, when bytes were lost on the way: the device
// didn't take it (line_overrun, checksum), or its reply isn't `intact`. The
// device took nothing then, so this holds for the opening and the last
// chunk of an upload too.
async function ask(client: Client, r: Request, tries = 4, timeoutMs = CHUNK_TIMEOUT_MS, intact = (_: Reply) => true) {
  for (let lost = 0; ; ) {
    const reply = await client.request(r, timeoutMs);
    if (reply.status === 'ok' ? !intact(reply) : /^(line_overrun|checksum)$/.test(reason(reply))) {
      if (++lost < 5) continue;
      return reply.status === 'ok' ? { status: 'bad_request', body: { error: 'bad_request', reason: 'checksum', message: 'the data arrived damaged' } } : reply;
    }
    if (!--tries || (reply.status !== 'timeout' && reply.status !== 'busy')) return reply;
    if (reply.status === 'busy') await new Promise((done) => setTimeout(done, 1000));
  }
}

// The body of a successful download is a File named by the device (empty
// when it gives no name), of its content type. progress gets 0 to 1 when
// the size is known.
export async function download(client: Client, path: string, progress: (f: number) => void): Promise<Reply> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const sums = client.features?.includes('crc32');
  let offset = 0;
  let head: { size?: number; filename?: string; contentType?: string } | undefined;
  type Chunk = typeof head & { data: string; end: boolean; crc32?: number };
  let bytes = new Uint8Array();
  // A chunk whose base64 or CRC-32 is broken is asked again.
  const intact = (r: Reply) => {
    const b = r.body as Chunk;
    try {
      bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0));
    } catch {
      return false;
    }
    return !sums || b.crc32 === crc32(bytes);
  };
  for (;;) {
    const r = await ask(client, { op: 'download', path, offset, ...(sums && { crc32: true }) }, 4, CHUNK_TIMEOUT_MS, intact);
    if (r.status !== 'ok') return r;
    const b = r.body as Chunk;
    head ??= b;
    parts.push(bytes);
    offset += bytes.length;
    if (head.size) progress(offset / head.size);
    if (b.end) return { status: 'ok', body: new File(parts, head.filename ?? '', { type: head.contentType }) };
  }
}

// The reply is the upload's: that of the chunk completing the file.
export async function upload(client: Client, path: string, file: File, progress: (f: number) => void): Promise<Reply> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const size = bytes.length;
  // Opened without data, to learn the device's chunk. Not asked again
  // unless the device didn't take it: an opening restarts the upload, and
  // the node's handler may take long (erasing a firmware partition).
  let r = await ask(client, { op: 'upload', path, size, filename: file.name }, 1, DEFERRED_TIMEOUT_MS);
  if (r.status !== 'ok' || !size) return r;
  const chunk = (r.body as { chunk: number }).chunk;
  const sums = client.features?.includes('crc32');
  for (let received = 0; ; ) {
    const end = Math.min(received + chunk, size);
    const part = bytes.subarray(received, end);
    // The last chunk's reply can't be asked again: the upload is over once
    // the device has it. Its handler's finish() may take long too.
    const last = end === size;
    const send: Request = { op: 'upload', path, offset: received, data: base64(part), ...(sums && { crc32: crc32(part) }) };
    r = await ask(client, send, last ? 1 : 4, last ? DEFERRED_TIMEOUT_MS : CHUNK_TIMEOUT_MS);
    if (r.status !== 'ok' || last) return r;
    received = (r.body as { received: number }).received;
    progress(received / size);
  }
}
