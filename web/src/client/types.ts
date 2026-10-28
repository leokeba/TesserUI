// The TesserAPI protocol as the renderer sees it (TesserAPI DESIGN.md §10.1).

// auth: lines only (serial, Bluetooth), the token for the line (TesserAPI §10.4).
// upload and download: file nodes, in chunks (TesserAPI §10.1.1).
export type Op = 'get' | 'set' | 'sub' | 'unsub' | 'auth' | 'upload' | 'download';

export interface Request {
  op: Op;
  path: string;
  depth?: number;
  keys?: string;
  exclude?: string;
  view?: 'value' | 'schema' | 'hash' | 'info';
  remotes?: boolean;
  interval?: number;
  // false: no events; a ui hint ("toast"): only the events that have it.
  events?: boolean | string;
  changes?: boolean;
  snapshot?: boolean;
  token?: string;
  // File transfers: where the chunk starts, the base64 bytes, and the
  // upload's size and name when it opens.
  offset?: number;
  data?: string;
  size?: number;
  filename?: string;
  // An upload chunk's CRC-32, or true for a download's (feature crc32).
  crc32?: number | boolean;
  body?: unknown;
}

// status is a TesserAPI status, or one of the client's own: "timeout" (no
// reply in time) and "disconnected" (the transport went down first).
export interface Reply {
  status: string;
  body: unknown;
}

export interface ErrorBody {
  error: string;
  // Why, by code, from protocol 2 (TesserAPI §10.1.2).
  reason?: string;
  path?: string;
  message?: string;
  partial?: boolean;
}

export interface Notification {
  op: 'change' | 'event';
  path: string;
  body: unknown;
  overflow?: boolean;
}

export type ConnState = 'connecting' | 'open' | 'down';

export interface Client {
  readonly kind: 'ws' | 'http' | 'serial' | 'ble';
  // false for plain HTTP: the store polls instead.
  readonly subscribes: boolean;
  // The node's protocol (TesserAPI §10.1.2), once read: 1 for one that
  // predates view=info; and the features its view=info lists.
  protocol?: number;
  features?: string[];
  // timeoutMs: REQUEST_TIMEOUT_MS by default; longer for deferred actions.
  request(r: Request, timeoutMs?: number): Promise<Reply>;
  onNotify(fn: (n: Notification) => void): void;
  onState(fn: (s: ConnState) => void): void;
  connect(): void;
  close(): void;
}

export const REQUEST_TIMEOUT_MS = 6000;
// Deferred actions reply when their work is done: TesserAPI's own limit
// (deferTimeoutMs) is 10 s.
export const DEFERRED_TIMEOUT_MS = 15000;

export function errorBody(r: Reply): ErrorBody {
  const b = r.body as ErrorBody | null;
  return b && typeof b === 'object' && typeof b.error === 'string' ? b : { error: r.status };
}

// Why a node refused: its error's reason (TesserAPI §10.1.2). An error
// without one comes from a node that predates reasons (protocol 1, perhaps a
// peer behind a newer gateway, which relays errors as they are): its message
// tells the few that matter here.
export function reason(r: Reply): string {
  const b = errorBody(r);
  const m = b.message ?? '';
  return b.reason ?? (/memory/.test(m) ? 'low_memory' : /pending/.test(m) ? 'pending_limit' : /queue/.test(m) ? 'queue_full' : /couldn't send/.test(m) ? 'unreachable' : '');
}

// A node short of memory for this reply: it may fit later, or in smaller
// pieces.
export const lowMemory = (r: Reply) => r.status === 'busy' && reason(r) === 'low_memory';

// A remote node too old to limit what a gateway's client may do
// (ceiling_unsupported, TesserAPI §13.1) says how to reach it again.
export function errorText(r: Reply, t: (text: string) => string = (x) => x): string {
  const b = errorBody(r);
  const text = b.reason === 'ceiling_unsupported' ? t("Only an admin reaches this node through a gateway until its firmware is updated") : b.message || b.error.replace(/_/g, ' ');
  return b.partial ? `${text} (${t('some changes were applied')})` : text;
}
