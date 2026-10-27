// A file node's transfer (DESIGN.md §4): a GET, or a PUT with the file as
// its body, with progress; in envelopes on a client with no HTTP (serial,
// Bluetooth), and below a remote node over a WebSocket. `filename` names
// the file within the node (a files widget's path, §4.1), sent as
// ?filename= or in the envelopes; an upload's defaults to the file's name.
// A download's reply body is a File named by the device; an upload's, the
// text of the device's reply.
import { download, upload } from '../client/files';
import { fileUrl } from '../client/http';
import { parse, stringify } from '../client/json';
import type { Reply } from '../client/types';
import type { Session } from '../store/session.svelte';

export async function transfer(session: Session, path: string, body: File | null, progress: (f: number) => void, filename?: string): Promise<Reply> {
  const client = session.fileClient(path);
  if (client) {
    const r = body ? await upload(client, path, body, progress, filename) : await download(client, path, progress, filename);
    if (r.status === 'unauthorized') session.store.onUnauthorized?.();
    return r.status === 'ok' && body ? { status: 'ok', body: stringify(r.body) } : r;
  }
  return new Promise((done) => {
    const x = new XMLHttpRequest();
    x.open(body ? 'PUT' : 'GET', fileUrl(session.apiUrl(), path, filename ?? body?.name));
    const token = session.token();
    if (token) x.setRequestHeader('Authorization', `Bearer ${token}`);
    if (!body) x.responseType = 'blob';
    (body ? x.upload : x).onprogress = (e) => e.lengthComputable && progress(e.loaded / e.total);
    x.onload = async () => {
      if (x.status < 300) {
        const name = /filename="?([^";]+)"?/.exec(x.getResponseHeader('Content-Disposition') ?? '')?.[1] ?? '';
        return done({ status: 'ok', body: body ? x.responseText : new File([x.response as Blob], name, { type: (x.response as Blob).type }) });
      }
      // An error's body, as text, only then.
      const text = body ? x.responseText : await (x.response as Blob).text();
      let reply: unknown = null;
      try {
        reply = parse(text);
      } catch {
        // not an error body
      }
      if (x.status === 403) session.store.onUnauthorized?.();
      done({ status: `http_${x.status}`, body: reply });
    };
    x.onerror = () => done({ status: 'disconnected', body: null });
    x.send(body);
  });
}

// Saves a download under `name`.
export function save(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
