// The serial line to the firmware just installed: the launcher's own
// envelope client, opened once and handed to the launcher's session, so the
// board isn't reset by a second opening of its port.

import { EnvelopeClient } from '../client/envelope';
import { serialLink } from '../client/lines';
import type { Client, ConnState } from '../client/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resolves once the firmware answers (a Wi-Fi node takes seconds to boot),
// or null after `waitMs`.
export async function openLine(port: SerialPort, waitMs = 60000): Promise<EnvelopeClient | null> {
  const client = new EnvelopeClient('serial', () => serialLink(port));
  client.connect();
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const r = await client.request({ op: 'get', path: '/', view: 'hash' }, 1500);
    if (r.status !== 'timeout' && r.status !== 'disconnected') return client;
    if (r.status === 'disconnected') await sleep(300);
  }
  client.close();
  return null;
}

// The open client as the session takes it: its connect() reports the line
// open at once instead of opening the port again.
export function handOver(client: EnvelopeClient): Client {
  const fns: ((s: ConnState) => void)[] = [];
  return {
    kind: 'serial',
    subscribes: true,
    request: (r, timeoutMs) => client.request(r, timeoutMs),
    onNotify: (fn) => client.onNotify(fn),
    onState(fn) {
      fns.push(fn);
      client.onState(fn);
    },
    connect() {
      if (client.state === 'open') for (const fn of fns) fn('open');
      else if (client.state === 'down') client.connect();
    },
    close: () => client.close(),
  };
}
