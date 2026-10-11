// A small mDNS browser (RFC 6762, 6763): "legacy" unicast queries sent from
// an ephemeral port to 224.0.0.251:5353, which responders answer directly
// to that port. No need to bind 5353, which the system's responder owns.

import dgram from 'node:dgram';
import os from 'node:os';

const PTR = 12;
const TXT = 16;
const A = 1;
const SRV = 33;

export function encodeQuery(name, type = PTR, id = 0) {
  const labels = name.replace(/\.$/, '').split('.');
  const parts = [Buffer.from([id >> 8, id & 255, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of labels) {
    const b = Buffer.from(l, 'utf8');
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0, type >> 8, type & 255, 0, 1]));
  return Buffer.concat(parts);
}

// A name at `offset`, following compression pointers. Returns the name and
// the offset after it in the message.
function readName(buf, offset) {
  const labels = [];
  let end = -1;
  for (let jumps = 0; jumps < 64; jumps++) {
    const len = buf[offset];
    if (len === undefined) throw new Error('truncated name');
    if (len === 0) {
      if (end < 0) end = offset + 1;
      return { name: labels.join('.'), end };
    }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = offset + 2;
      offset = ((len & 0x3f) << 8) | buf[offset + 1];
      continue;
    }
    labels.push(buf.toString('utf8', offset + 1, offset + 1 + len));
    offset += 1 + len;
  }
  throw new Error('name loop');
}

// The records of a response: answers, authorities and additionals together.
export function decodeRecords(buf) {
  const qd = buf.readUInt16BE(4);
  const rr = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let o = 12;
  for (let i = 0; i < qd; i++) o = readName(buf, o).end + 4;
  const records = [];
  for (let i = 0; i < rr; i++) {
    const { name, end } = readName(buf, o);
    const type = buf.readUInt16BE(end);
    const ttl = buf.readUInt32BE(end + 4);
    const len = buf.readUInt16BE(end + 8);
    const at = end + 10;
    let data = null;
    if (type === PTR) data = readName(buf, at).name;
    else if (type === SRV) data = { port: buf.readUInt16BE(at + 4), target: readName(buf, at + 6).name };
    else if (type === A) data = [...buf.subarray(at, at + 4)].join('.');
    else if (type === TXT) {
      data = {};
      for (let p = at; p < at + len; ) {
        const s = buf.toString('utf8', p + 1, p + 1 + buf[p]);
        p += 1 + buf[p];
        const eq = s.indexOf('=');
        if (s) data[eq < 0 ? s : s.slice(0, eq)] = eq < 0 ? true : s.slice(eq + 1);
      }
    }
    records.push({ name, type, ttl, data });
    o = at + len;
  }
  return records;
}

// The services of a type found within `timeoutMs`: [{instance, host, port,
// target, txt}]. Queries go out on every IPv4 interface.
export async function browse(service = '_tesser._tcp.local', timeoutMs = 1500) {
  const sock = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => sock.bind(0, resolve).once('error', reject));
  const records = [];
  sock.on('message', (msg) => {
    try {
      records.push(...decodeRecords(msg));
    } catch {
      // a malformed packet
    }
  });
  // Sends are asynchronous and the interface is a socket option: each send
  // completes before the next interface is set.
  const ask = async (name, type) => {
    const q = encodeQuery(name, type, Math.floor(Math.random() * 65535));
    for (const addr of interfaces()) {
      try {
        sock.setMulticastInterface(addr);
        await new Promise((resolve) => sock.send(q, 5353, '224.0.0.251', resolve));
      } catch {
        // an interface without multicast
      }
    }
  };
  await ask(service, PTR);
  await sleep(timeoutMs / 2);
  // Instances whose SRV, TXT or address didn't come with the answer.
  for (const r of records.filter((r) => r.type === PTR && r.name === service)) {
    if (!records.some((s) => s.type === SRV && s.name === r.data)) await ask(r.data, SRV);
    if (!records.some((s) => s.type === TXT && s.name === r.data)) await ask(r.data, TXT);
  }
  await sleep(timeoutMs / 4);
  for (const s of records.filter((r) => r.type === SRV)) {
    if (!records.some((a) => a.type === A && a.name === s.data.target)) await ask(s.data.target, A);
  }
  await sleep(timeoutMs / 4);
  sock.close();

  const found = new Map();
  for (const r of records.filter((r) => r.type === PTR && r.name === service && r.ttl > 0)) {
    const srv = records.find((s) => s.type === SRV && s.name === r.data)?.data;
    if (!srv) continue;
    const host = records.find((a) => a.type === A && a.name === srv.target)?.data;
    const txt = records.find((t) => t.type === TXT && t.name === r.data)?.data ?? {};
    const instance = r.data.slice(0, -(service.length + 1));
    found.set(r.data, { instance, host: host ?? srv.target, port: srv.port, target: srv.target, txt });
  }
  return [...found.values()];
}

function interfaces() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
