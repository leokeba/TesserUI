#!/usr/bin/env node
// tesserui-bridge (docs/DESIGN.md §9.7): what a web page can't do by itself,
// on localhost for TesserUI's launcher.
//
//   - Finds the TesserAPI nodes on the network (mDNS, _tesser._tcp) and lists
//     them, with the serial ports, at GET /nodes.
//   - Proxies each node's API and WebSocket: a page on HTTPS (GitHub Pages)
//     reaches http:// and ws:// on localhost, which browsers trust, so nodes
//     are live in every browser, not only Chromium's local network access.
//   - Carries serial ports over WebSocket, for browsers without Web Serial.
//   - Serves the launcher itself at /, when the bundle is at hand.
//
// Only pages from allowed origins may use it (GitHub Pages, localhost, and
// --origin), and it only reaches nodes it listed: a page can't use it to
// reach anything else.
//
//   tesserui-bridge [--port 8765] [--origin https://example.com]... [--node host[:port]]...
//                   [--no-mdns] [--no-serial]

import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { browse } from './mdns.mjs';

const args = process.argv.slice(2);
const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
const port = Number(values('--port')[0] ?? 8765);
const origins = ['https://leokeba.github.io', ...values('--origin')];
const useMdns = !args.includes('--no-mdns');
const useSerial = !args.includes('--no-serial');
const version = '0.1.0';

// Origins that may use the bridge: the launcher's, any page on this machine,
// and those given. Requests without an Origin come from tools, not pages.
function allowed(origin) {
  if (!origin) return true;
  if (origins.includes('*') || origins.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

// Nodes by id ("host:port"): found by mDNS, or given with --node.
const nodes = new Map();
for (const n of values('--node')) {
  const [host, p = '80'] = n.split(':');
  addNode({ name: n, host, port: Number(p), api: '/api', ws: '/ws', via: 'manual' });
}

function addNode(n) {
  const id = `${n.host}:${n.port}`;
  const known = nodes.get(id);
  nodes.set(id, { ...known, ...n, id, seen: Date.now() });
  if (!known) describe(id);
}

// The node's label, from its schema: what the launcher lists; and its
// device id (TesserAPI's root "id"), if mDNS didn't give it.
async function describe(id) {
  const n = nodes.get(id);
  try {
    const r = await fetch(`http://${id}${n.api}/?view=schema&depth=0`, { signal: AbortSignal.timeout(3000) });
    const s = await r.json();
    if (typeof s?.label === 'string') n.label = s.label;
    if (typeof s?.id === 'string') n.device ??= s.id;
  } catch {
    // not answering yet: listed by name
  }
}

async function discover() {
  try {
    for (const s of await browse()) {
      addNode({ name: s.instance, host: s.host, port: s.port, api: s.txt.api || '/api', ws: s.txt.ws || null, via: 'mdns', hostname: s.target, ...(s.txt.id && { device: s.txt.id }) });
    }
  } catch (e) {
    console.error('mdns:', e.message);
  }
  // Gone for a minute: forgotten.
  for (const [id, n] of nodes) if (n.via === 'mdns' && Date.now() - n.seen > 60000) nodes.delete(id);
}

// Serial ports, through the optional serialport package.
let SerialPort = null;
if (useSerial) {
  try {
    ({ SerialPort } = await import('serialport'));
  } catch {
    console.error('serial: the serialport package is missing; serial ports are off');
  }
}

async function serialPorts() {
  if (!SerialPort) return [];
  // macOS lists /dev/tty.*, whose open waits for a carrier: use /dev/cu.*.
  const list = await SerialPort.list();
  return list
    .filter((p) => p.vendorId || /usb|serial|acm/i.test(p.path))
    .map((p) => {
      const path = p.path.replace('/dev/tty.', '/dev/cu.');
      return { path, name: `${p.manufacturer ?? 'Serial'} (${path.split('/').pop()})` };
    });
}

const base = `http://localhost:${port}`;
const wsBase = `ws://localhost:${port}`;
async function listing() {
  return {
    bridge: version,
    nodes: [...nodes.values()].map((n) => ({
      id: n.id,
      name: n.name,
      label: n.label ?? n.name,
      // The device's MAC, as in a gateway's remote stubs: one node reached
      // several ways is one tab in the launcher.
      device: n.device ?? null,
      host: n.hostname ?? n.host,
      address: n.id,
      api: `${base}/n/${encodeURIComponent(n.id)}/api`,
      ws: n.ws ? `${wsBase}/n/${encodeURIComponent(n.id)}/ws` : null,
    })),
    ports: (await serialPorts()).map((p) => ({ ...p, ws: `${wsBase}/s/${encodeURIComponent(p.path)}` })),
  };
}

// The launcher's own files: built into the executable (scripts/macos.mjs),
// else from this package (ui/) or the repository's build.
const dir = [new URL('./ui/', import.meta.url), new URL('../web/dist/', import.meta.url)].find((u) => existsSync(new URL('ui.js', u)));
const builtIn = globalThis.tesseruiLauncher;
const ui = builtIn ? (name) => builtIn[name] : dir && ((name) => readFileSync(new URL(name, dir), 'utf8'));

function cors(origin) {
  return origin
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, OPTIONS', 'Access-Control-Allow-Private-Network': 'true', Vary: 'Origin' }
    : {};
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!allowed(origin)) return res.writeHead(403).end('origin not allowed\n');
  const h = cors(origin);
  if (req.method === 'OPTIONS') return res.writeHead(204, h).end();
  const url = new URL(req.url, base);

  if (url.pathname === '/nodes') {
    return res.writeHead(200, { ...h, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(await listing()));
  }

  // /n/<id>/api/...: the node's HTTP API. /n/<id>/<path>: the node's other
  // files, read only (custom elements' scripts, DESIGN.md §9.8).
  const m = url.pathname.match(/^\/n\/([^/]+)(\/api)?(\/.*)?$/);
  if (m) {
    const n = nodes.get(decodeURIComponent(m[1]));
    if (!n) return res.writeHead(404, h).end();
    if (!m[2] && !['GET', 'HEAD'].includes(req.method)) return res.writeHead(405, h).end();
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(await Array.fromAsync(req));
    // The node has 30 s to answer; the body then flows as long as it lasts
    // (a streamed subscription: hours), until the browser goes away.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    res.on('close', () => ctl.abort());
    try {
      const r = await fetch(`http://${n.id}${m[2] ? n.api : ''}${m[3] ?? (m[2] ? '' : '/')}${url.search}`, {
        method: req.method,
        headers: Object.fromEntries(['authorization', 'content-type'].filter((k) => req.headers[k]).map((k) => [k, req.headers[k]])),
        body,
        signal: ctl.signal,
      });
      clearTimeout(timer);
      // fetch() decodes a gzipped body: its length is no longer the node's.
      const keep = ['content-type', 'content-disposition', 'cache-control', ...(r.headers.get('content-encoding') ? [] : ['content-length'])];
      const pass = Object.fromEntries(keep.filter((k) => r.headers.get(k)).map((k) => [k, r.headers.get(k)]));
      res.writeHead(r.status, { ...h, ...pass });
      if (r.body) Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
      else res.end();
    } catch {
      clearTimeout(timer);
      if (!res.headersSent) res.writeHead(502, h).end();
    }
    return;
  }

  if (ui && (url.pathname === '/ui.js' || url.pathname === '/launcher.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    return res.end(ui(url.pathname.slice(1)));
  }
  // The launcher, told that its own origin is the bridge.
  if (ui && url.pathname === '/') {
    const page = ui('index.html').replace('<head>', '<head><meta name="tesserui-bridge" content="">');
    return res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }).end(page);
  }
  res.writeHead(404, h).end();
});

// WebSockets: /n/<id>/ws to a node's, /s/<path> to a serial port.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!allowed(req.headers.origin)) return socket.destroy();
  const url = new URL(req.url, base);
  const n = url.pathname.match(/^\/n\/([^/]+)\/ws$/);
  const s = url.pathname.match(/^\/s\/(.+)$/);
  const node = n && nodes.get(decodeURIComponent(n[1]));
  if (node?.ws) return wss.handleUpgrade(req, socket, head, (ws) => proxyWs(ws, `ws://${node.id}${node.ws}${url.search}`));
  if (s && SerialPort) return wss.handleUpgrade(req, socket, head, (ws) => serial(ws, decodeURIComponent(s[1])));
  socket.destroy();
});

function proxyWs(client, target) {
  const up = new WebSocket(target);
  const early = [];
  client.on('message', (data, binary) => (up.readyState === WebSocket.OPEN ? up.send(data, { binary }) : early.push([data, binary])));
  up.on('open', () => early.splice(0).forEach(([d, binary]) => up.send(d, { binary })));
  up.on('message', (data, binary) => client.send(data, { binary }));
  const end = () => {
    client.close();
    up.terminate();
  };
  up.on('close', end);
  up.on('error', end);
  client.on('close', end);
}

// One page per port at a time: a new one takes it over.
const lines = new Map();
async function serial(ws, path) {
  lines.get(path)?.close();
  lines.set(path, ws);
  const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
  try {
    await new Promise((resolve, reject) => port.open((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    ws.close(1011, String(e.message).slice(0, 100));
    return;
  }
  port.write('\n');  // opening resets most devkits: flush what the board got while booting
  let buf = '';
  port.on('data', (d) => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const at = line.indexOf('{"');
      if (at >= 0 && ws.readyState === WebSocket.OPEN) ws.send(line.slice(at).replace(/\r$/, ''));
    }
  });
  ws.on('message', (data) => port.write(data.toString() + '\n'));
  const end = () => {
    if (lines.get(path) === ws) lines.delete(path);
    ws.close();
    if (port.isOpen) port.close();
  };
  port.on('close', end);
  port.on('error', end);
  ws.on('close', end);
}

server.listen(port, '127.0.0.1', () => {
  console.log(`tesserui-bridge ${version} on ${base}/  (nodes: ${base}/nodes)`);
  console.log(`launcher: https://leokeba.github.io/TesserUI/${ui ? `  or ${base}/` : ''}`);
});
if (useMdns) {
  discover();
  setInterval(discover, 10000);
}
