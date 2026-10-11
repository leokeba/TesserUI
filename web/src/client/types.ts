// The TesserAPI protocol as the renderer sees it (TesserAPI DESIGN.md §10.1).

// auth: lines only (serial, Bluetooth), the token for the line (TesserAPI §10.4).
export type Op = 'get' | 'set' | 'sub' | 'unsub' | 'auth';

export interface Request {
  op: Op;
  path: string;
  depth?: number;
  keys?: string;
  exclude?: string;
  view?: 'value' | 'schema' | 'hash';
  remotes?: boolean;
  interval?: number;
  events?: boolean;
  changes?: boolean;
  snapshot?: boolean;
  token?: string;
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

export function errorText(r: Reply, t: (text: string) => string = (x) => x): string {
  const b = errorBody(r);
  const text = b.message || b.error.replace(/_/g, ' ');
  return b.partial ? `${text} (${t('some changes were applied')})` : text;
}
