import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeRecords, encodeQuery } from '../mdns.mjs';

const name = (n) => Buffer.concat([...n.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
const u16 = (v) => Buffer.from([v >> 8, v & 255]);
const record = (owner, type, data) => Buffer.concat([owner, u16(type), u16(1), Buffer.from([0, 0, 0, 120]), u16(data.length), data]);

test('a PTR query for a service', () => {
  const q = encodeQuery('_tesser._tcp.local', 12, 0x1234);
  assert.deepEqual([...q.subarray(0, 6)], [0x12, 0x34, 0, 0, 0, 1]);
  assert.deepEqual(q.subarray(12), Buffer.concat([name('_tesser._tcp.local'), Buffer.from([0, 12, 0, 1])]));
});

test('a response as ESP-IDF sends it: PTR, SRV, TXT and A, names compressed', () => {
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3]);
  const service = name('_tesser._tcp.local');
  // The instance points back at the service's name (offset 12).
  const instance = Buffer.concat([Buffer.from([11]), Buffer.from('tesser-a67c'), Buffer.from([0xc0, 12])]);
  const ptr = record(service, 12, instance);
  const instanceAt = 12 + service.length + 10;  // the PTR's data
  const at = Buffer.from([0xc0, instanceAt]);
  const srv = record(at, 33, Buffer.concat([u16(0), u16(0), u16(80), name('tesser-a67c.local')]));
  const txt = record(at, 16, Buffer.concat([Buffer.from([8]), Buffer.from('api=/api'), Buffer.from([6]), Buffer.from('ws=/ws'), Buffer.from([4]), Buffer.from('flag')]));
  const a = record(name('tesser-a67c.local'), 1, Buffer.from([192, 168, 1, 59]));
  const records = decodeRecords(Buffer.concat([header, ptr, srv, txt, a]));
  assert.deepEqual(
    records.map((r) => [r.name, r.type, r.data]),
    [
      ['_tesser._tcp.local', 12, 'tesser-a67c._tesser._tcp.local'],
      ['tesser-a67c._tesser._tcp.local', 33, { port: 80, target: 'tesser-a67c.local' }],
      ['tesser-a67c._tesser._tcp.local', 16, { api: '/api', ws: '/ws', flag: true }],
      ['tesser-a67c.local', 1, '192.168.1.59'],
    ],
  );
});

test('a compression loop is refused', () => {
  const looped = Buffer.concat([Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from([0xc0, 12])]);
  assert.throws(() => decodeRecords(looped), /name loop/);
});
