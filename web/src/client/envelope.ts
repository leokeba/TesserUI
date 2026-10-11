// Envelope client over a message link: WebSocket, Web Serial or Web Bluetooth
// (DESIGN.md §9.2). Numeric ids, a timeout per request, reconnection with backoff.

import { isObject, parse, stringify } from './json';
import { REQUEST_TIMEOUT_MS, type Client, type ConnState, type Notification, type Reply, type Request } from './types';

export interface Link {
  // Resolves once the link can send; onClose fires once, whenever it ends.
  open(onMessage: (text: string) => void, onClose: () => void): Promise<void>;
  send(text: string): void;
  close(): void;
}

const BACKOFF_MS = [500, 1000, 2000, 5000];

interface Pending {
  resolve: (r: Reply) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EnvelopeClient implements Client {
  readonly subscribes = true;
  private link: Link | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notify: ((n: Notification) => void)[] = [];
  private stateFns: ((s: ConnState) => void)[] = [];
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  state: ConnState = 'down';
  // How many times the link opened, so callers can tell a first failure.
  opened = 0;

  constructor(
    readonly kind: 'ws' | 'serial' | 'ble',
    private makeLink: () => Link,
  ) {}

  onNotify(fn: (n: Notification) => void) {
    this.notify.push(fn);
  }

  onState(fn: (s: ConnState) => void) {
    this.stateFns.push(fn);
  }

  private setState(s: ConnState) {
    this.state = s;
    for (const fn of this.stateFns) fn(s);
  }

  connect() {
    this.closed = false;
    clearTimeout(this.retry);
    this.setState('connecting');
    const link = this.makeLink();
    this.link = link;
    link.open(
      (text) => this.receive(text),
      () => {
        if (this.link !== link) return;
        this.link = null;
        this.failAll();
        this.setState('down');
        if (!this.closed) this.retry = setTimeout(() => this.connect(), BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]);
      },
    ).then(
      () => {
        if (this.link !== link) return;
        this.attempt = 0;
        this.opened++;
        this.setState('open');
      },
      () => {},
    );
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    const link = this.link;
    this.link = null;
    link?.close();
    this.failAll();
    this.setState('down');
  }

  request(r: Request, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Reply> {
    return new Promise((resolve) => {
      if (!this.link || this.state !== 'open') return resolve({ status: 'disconnected', body: null });
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ status: 'timeout', body: { error: 'timeout', message: 'no reply' } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      const env: Record<string, unknown> = { id, ...r };
      if (r.body === undefined) delete env.body;
      this.link.send(stringify(env));
    });
  }

  private receive(text: string) {
    let msg: unknown;
    try {
      msg = parse(text);
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    if (typeof msg.id === 'number' && typeof msg.status === 'string') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve({ status: msg.status, body: msg.body ?? null });
    } else if ((msg.op === 'change' || msg.op === 'event') && typeof msg.path === 'string') {
      const n = msg as unknown as Notification;
      for (const fn of this.notify) fn(n);
    }
  }

  private failAll() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ status: 'disconnected', body: null });
    }
    this.pending.clear();
  }
}

export function webSocketLink(url: string): Link {
  let ws: WebSocket | null = null;
  return {
    open(onMessage, onClose) {
      return new Promise((resolve, reject) => {
        let done = false;
        const end = () => {
          if (done) return;
          done = true;
          reject(new Error('closed'));
          onClose();
        };
        // Throws on an HTTPS page for a ws:// URL (mixed content).
        try {
          ws = new WebSocket(url);
        } catch {
          return setTimeout(end);
        }
        ws.onopen = () => resolve();
        ws.onmessage = (e) => typeof e.data === 'string' && onMessage(e.data);
        ws.onclose = end;
        ws.onerror = () => ws?.close();
      });
    },
    send(text) {
      ws?.send(text);
    },
    close() {
      ws?.close();
    },
  };
}

// Newline-delimited envelopes over a byte stream (Web Serial, Bluetooth).
// Lines that don't contain an envelope are log output; parsing starts at the
// first {" of a line, since ESP log lines interleave (DESIGN.md §9.7).
function lineReader(onMessage: (text: string) => void) {
  const dec = new TextDecoder();
  let buf = '';
  return (bytes: Uint8Array) => {
    buf += dec.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const start = line.indexOf('{"');
      if (start >= 0) onMessage(line.slice(start));
    }
  };
}

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

export function serialLink(port: SerialPortLike, baudRate = 115200): Link {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const enc = new TextEncoder();
  return {
    async open(onMessage, onClose) {
      try {
        await port.open({ baudRate });
      } catch (e) {
        onClose();
        throw e;
      }
      writer = port.writable!.getWriter();
      reader = port.readable!.getReader();
      // Opening the port resets most devkits; a bare newline flushes any
      // garbage the board received while booting.
      writer.write(enc.encode('\n'));
      const lines = lineReader(onMessage);
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader!.read();
            if (done) break;
            lines(value);
          }
        } catch {
          // device unplugged
        }
        try {
          reader?.releaseLock();
          writer?.releaseLock();
          await port.close();
        } catch {
          // already closed
        }
        onClose();
      })();
    },
    send(text) {
      writer?.write(enc.encode(text + '\n'));
    },
    close() {
      reader?.cancel().catch(() => {});
    },
  };
}

// The same lines over Bluetooth LE (DESIGN.md §9.7): TesserAPI's
// BleTransport serves the Nordic UART Service. Writes go to RX, with a
// response so that each chunk is acknowledged; a chunk longer than the MTU
// becomes a long write. Replies come as indications on TX, in MTU-sized
// pieces that the line reader joins.
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';

interface GattCharacteristic extends EventTarget {
  value?: DataView;
  writeValueWithResponse(data: Uint8Array): Promise<void>;
  startNotifications(): Promise<unknown>;
}
interface BluetoothDeviceLike extends EventTarget {
  gatt?: {
    connect(): Promise<{ getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<GattCharacteristic> }> }>;
    disconnect(): void;
  };
}

export function bleLink(device: BluetoothDeviceLike): Link {
  let rx: GattCharacteristic | null = null;
  let queue = Promise.resolve();
  const enc = new TextEncoder();
  return {
    async open(onMessage, onClose) {
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        device.removeEventListener('gattserverdisconnected', end);
        onClose();
      };
      device.addEventListener('gattserverdisconnected', end);
      try {
        const service = await (await device.gatt!.connect()).getPrimaryService(NUS_SERVICE);
        rx = await service.getCharacteristic(NUS_RX);
        const tx = await service.getCharacteristic(NUS_TX);
        const lines = lineReader(onMessage);
        tx.addEventListener('characteristicvaluechanged', () => {
          const v = tx.value!;
          lines(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        });
        await tx.startNotifications();
      } catch (e) {
        device.gatt?.disconnect();
        end();
        throw e;
      }
    },
    send(text) {
      const bytes = enc.encode(text + '\n');
      // One write at a time: Web Bluetooth refuses overlapping operations.
      for (let i = 0; i < bytes.length; i += 512) {
        const chunk = bytes.subarray(i, i + 512);
        queue = queue.then(() => rx?.writeValueWithResponse(chunk)).catch(() => {});
      }
    },
    close() {
      device.gatt?.disconnect();
    },
  };
}
