// Web Serial and Web Bluetooth links (DESIGN.md §9.2, §9.7). ui.js loads
// them with its connection screen, a chunk (§9.4); the launcher and the npm
// module import them as usual. Loading them gives the session its links.

import type { Link } from './envelope';
import { links } from '../store/session.svelte';

// Newline-delimited envelopes over a byte stream (Web Serial, Bluetooth).
// An envelope is a whole line, after any noise a UART picks up while the
// board resets (control bytes, 0xff), as TesserAPI's LineTransport reads
// them. Every other line is log output, even one holding JSON (DESIGN.md
// §9.2).
function lineReader(onMessage: (text: string) => void) {
  const dec = new TextDecoder();
  let buf = '';
  return (bytes: Uint8Array) => {
    buf += dec.decode(bytes, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const text = line.replace(/^[^!-~]+/, '');
      if (text.startsWith('{"')) onMessage(text);
    }
  };
}

export interface SerialPortLike {
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
      return writer?.write(enc.encode(text + '\n'));
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
export interface BluetoothDeviceLike extends EventTarget {
  id?: string;
  name?: string;
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
      const sent = queue.then(async () => {
        for (let i = 0; i < bytes.length; i += 512) await rx!.writeValueWithResponse(bytes.subarray(i, i + 512));
      });
      // A write that fails leaves part of a line on the device: the rest of
      // the message is dropped and a newline ends the line, so the device
      // drops it too and reads the next envelope whole. When even that
      // fails, the link goes (and opens again).
      queue = sent.catch(() => rx!.writeValueWithResponse(enc.encode('\n')).catch(() => device.gatt?.disconnect()));
      return sent;
    },
    close() {
      device.gatt?.disconnect();
    },
  };
}

links.serial = serialLink;
links.ble = bleLink;
