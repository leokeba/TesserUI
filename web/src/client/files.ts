// File transfers in envelopes (TesserAPI DESIGN.md §10.1.1), for clients
// with no HTTP (serial and Bluetooth lines, a bridge's serial port) and for
// files below a remote node over a WebSocket. One envelope per chunk, the
// bytes in base64. A chunk whose reply doesn't come is sent again at the
// same offset, which the device makes harmless.

import { DEFERRED_TIMEOUT_MS, type Client, type Reply, type Request } from './types';

const base64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

// Longer than a gateway relaying a chunk to a remote node tries it itself
// (three times its 3 s timeout, TesserAPI §14), after which it answers
// `timeout`.
const CHUNK_TIMEOUT_MS = 10000;

// Asked again while it times out, or a moment later while it is `busy`: a
// gateway still relaying the try given up on, or at its maxPending.
async function ask(client: Client, r: Request, tries = 4, timeoutMs = CHUNK_TIMEOUT_MS) {
  for (;;) {
    const reply = await client.request(r, timeoutMs);
    if (!--tries || (reply.status !== 'timeout' && reply.status !== 'busy')) return reply;
    if (reply.status === 'busy') await new Promise((done) => setTimeout(done, 1000));
  }
}

// The body of a successful download is a File named by the device (empty
// when it gives no name), of its content type. progress gets 0 to 1 when
// the size is known.
export async function download(client: Client, path: string, progress: (f: number) => void): Promise<Reply> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  let head: { size?: number; filename?: string; contentType?: string } | undefined;
  for (;;) {
    const r = await ask(client, { op: 'download', path, offset });
    if (r.status !== 'ok') return r;
    const b = r.body as typeof head & { data: string; end: boolean };
    head ??= b;
    const bytes = Uint8Array.from(atob(b.data), (c) => c.charCodeAt(0));
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
  // Opened without data, to learn the device's chunk. Not asked again: an
  // opening restarts the upload, and the node's handler may take long
  // (erasing a firmware partition).
  let r = await client.request({ op: 'upload', path, size, filename: file.name }, DEFERRED_TIMEOUT_MS);
  if (r.status !== 'ok' || !size) return r;
  const chunk = (r.body as { chunk: number }).chunk;
  for (let received = 0; ; ) {
    const end = Math.min(received + chunk, size);
    const data = base64(bytes.subarray(received, end));
    // The last chunk's reply can't be asked again: the upload is over once
    // the device has it. Its handler's finish() may take long too.
    const last = end === size;
    r = await ask(client, { op: 'upload', path, offset: received, data }, last ? 1 : 4, last ? DEFERRED_TIMEOUT_MS : CHUNK_TIMEOUT_MS);
    if (r.status !== 'ok' || last) return r;
    received = (r.body as { received: number }).received;
    progress(received / size);
  }
}
