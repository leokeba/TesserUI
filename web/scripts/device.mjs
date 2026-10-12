// A TesserAPI node on the host, for development, demos and end-to-end
// tests: the C++ demo tree (build/tesserui_demo, real TesserAPI) served the
// way a self-hosted node serves it (TesserUI's WebUi): the page at /, the
// built bundle at /ui.js, the API at /api and WebSocket at /ws.
//
//   node scripts/device.mjs [demo|motors] [--port 8090] [--isolated] [--exe path/to/node]
//                           [--elements dir]...
//   (/ext/<name>.js serves the custom elements: from each --elements
//   directory in turn, then examples/elements/, the demo's)
//   then open http://localhost:8090/            (the built bundle: pnpm build)
//   or        http://localhost:5173/?api=http://localhost:8090/api   (pnpm dev)
//
// All clients share one node, as browsers share a real one. With
// --isolated, each WebSocket connection gets a node of its own instead,
// fresh from the demo tree's initial state (end-to-end tests).

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const valued = ['--port', '--exe', '--elements'];
const tree = args.find((a, i) => !a.startsWith('--') && !valued.includes(args[i - 1])) ?? 'demo';
const fromCwd = (p) => new URL(p, `file://${process.cwd()}/`);
const port = Number(args[args.indexOf('--port') + 1]) || 8090;
const isolated = args.includes('--isolated');
// --exe: another node speaking the same protocol (TesserKIT's tesserkit_demo).
const exe = args.includes('--exe')
  ? fromCwd(args[args.indexOf('--exe') + 1]).pathname
  : new URL('../../build/tesserui_demo', import.meta.url).pathname;
const dist = new URL('../dist/', import.meta.url);
// Custom elements (DESIGN.md §9.8), served at /ext/: an application's own
// (--elements, the first that has the file wins), then the demo tree's.
const elements = [
  ...args.flatMap((a, i) => (args[i - 1] === '--elements' ? [fromCwd(a.endsWith('/') ? a : a + '/')] : [])),
  new URL('../../examples/elements/', import.meta.url),
];
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function node(extra, onLine) {
  const p = spawn(exe, [tree, ...extra], { stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: p.stdout }).on('line', onLine);
  p.on('error', (e) => console.error(`${exe}: ${e.message} (build it with cmake first)`));
  return p;
}

// The shared node: lines are "<client> <envelope>" both ways (tesserui_demo
// --clients). Client 0 carries the HTTP requests.
const clients = new Map();
let nextClient = 1;
const shared = node(['--clients'], (line) => {
  const sp = line.indexOf(' ');
  clients.get(Number(line.slice(0, sp)))?.(line.slice(sp + 1));
});
const sendShared = (client, text) => shared.stdin.write(`${client} ${text.replace(/\n/g, ' ')}\n`);

// HTTP → envelope, as TesserAPI's HttpServer maps them (its DESIGN.md §10.2).
const STATUS = { ok: 200, bad_request: 400, not_found: 404, invalid_value: 422, read_only: 405, not_allowed: 405, unauthorized: 403, too_large: 413, busy: 503, timeout: 504, internal: 500 };
const waiting = new Map();
let nextId = 1;
clients.set(0, (line) => {
  // {"id":…,"status":"…","body":…}: the body is the rest of the line, kept
  // as text so 64-bit integers stay exact.
  const m = /^\{"id":(\d+),"status":"(\w+)"(?:,"body":)?/.exec(line);
  if (!m) return;
  waiting.get(Number(m[1]))?.(m[2], line.length > m[0].length ? line.slice(m[0].length, -1) : 'null');
  waiting.delete(Number(m[1]));
});

// The page WebUi generates (src/tesserui/web_page.cpp), and the bundle.
const page =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  `<title>TesserUI</title><link rel="icon" href="data:,"><script>window.TESSER={api:"/api",ws:"/ws",minVersion:"${version}"}</script>` +
  '</head><body><script src="/ui.js"></script></body></html>';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, PATCH, OPTIONS' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (url.pathname === '/') return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }).end(page);
  if (url.pathname === '/ui.js') {
    const gz = new URL('ui.js.gz', dist);
    if (!existsSync(gz)) return res.writeHead(404).end('no bundle: run pnpm build');
    return res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache' }).end(readFileSync(gz));
  }
  if (url.pathname.startsWith('/ext/')) {
    const name = url.pathname.slice(5).replace(/[^\w.-]/g, '');
    const file = elements.map((dir) => new URL(name, dir)).find((f) => existsSync(f) && statSync(f).isFile());
    if (!file) return res.writeHead(404, cors).end();
    return res.writeHead(200, { ...cors, 'Content-Type': 'text/javascript' }).end(readFileSync(file));
  }
  if (!url.pathname.startsWith('/api')) return res.writeHead(404, cors).end();
  if (req.method === 'GET' && /^(1|true|)$/.test(url.searchParams.get('sub') ?? 'no')) return stream(url, res);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString();
    // An upload: bytes that aren't JSON, or a file's name.
    if (req.method !== 'GET' && (url.searchParams.has('filename') || !isJson(body))) return file(url, req, res, raw);
    const id = nextId++;
    const env = { id, op: req.method === 'GET' ? 'get' : 'set', path: url.pathname.slice(4) || '/' };
    for (const k of ['depth', 'keys', 'exclude', 'view', 'remotes']) {
      const v = url.searchParams.get(k);
      if (v !== null) env[k] = k === 'depth' ? Number(v) : k === 'remotes' ? v !== 'false' : v;
    }
    let line = JSON.stringify(env);
    // The body is spliced in as text, so 64-bit integers stay exact.
    if (body) line = line.slice(0, -1) + `,"body":${body}}`;
    waiting.set(id, (status, text) => {
      // A file node refuses JSON requests, saying so: its bytes move instead.
      if (status === 'not_allowed' && /files over HTTP/.test(text)) return file(url, req, res, raw);
      res.writeHead(STATUS[status] ?? 500, { ...cors, 'Content-Type': 'application/json' }).end(text);
    });
    sendShared(0, line);
  });
});

function isJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// A file node, whose raw bytes TesserAPI's HttpServer moves (GET, and PUT
// ?filename=): a client of its own moves them in download or upload
// envelopes (TesserAPI §10.1.1).
async function file(url, req, res, raw) {
  const client = nextClient++;
  const path = url.pathname.slice(4) || '/';
  const op = req.method === 'GET' ? 'download' : 'upload';
  let id = 0;
  const ask = (env) =>
    new Promise((resolve) => {
      clients.set(client, (line) => {
        const m = /^\{"id":\d+,"status":"(\w+)"(?:,"body":)?/.exec(line);
        if (!m) return;
        const text = line.length > m[0].length ? line.slice(m[0].length, -1) : 'null';
        resolve({ status: m[1], text, body: JSON.parse(text) });
      });
      sendShared(client, JSON.stringify({ id: ++id, op, path, ...env }));
    });
  const end = (r, headers = { 'Content-Type': 'application/json' }, body = r.text) =>
    res.writeHead(STATUS[r.status] ?? 500, { ...cors, ...headers }).end(body);
  try {
    if (op === 'download') {
      const parts = [];
      let r = await ask({ offset: 0 });
      const head = r.body;
      for (let offset = 0; r.status === 'ok'; r = await ask({ offset })) {
        parts.push(Buffer.from(r.body.data, 'base64'));
        offset += parts.at(-1).length;
        if (r.body.end) {
          const headers = { 'Content-Type': head.contentType, 'Content-Disposition': `attachment; filename="${head.filename}"`, 'Access-Control-Expose-Headers': 'Content-Disposition' };
          return end(r, headers, Buffer.concat(parts));
        }
      }
      return end(r);
    }
    const filename = url.searchParams.get('filename') ?? undefined;
    let r = await ask({ size: raw.length, filename });
    const chunk = r.body?.chunk;
    for (let at = 0; r.status === 'ok' && at < raw.length; at += chunk) {
      r = await ask({ offset: at, data: raw.subarray(at, at + chunk).toString('base64') });
    }
    end(r);
  } finally {
    clients.delete(client);
    sendShared(client, 'close');
  }
}

// A streamed subscription (TesserAPI's HttpServer, GET ?sub): a client of
// its own on the shared node, its notifications one per line, a newline
// after 15 s of silence, and the subscription gone with the connection.
function stream(url, res) {
  const client = nextClient++;
  const env = { id: 1, op: 'sub', path: url.pathname.slice(4) || '/' };
  for (const k of ['events', 'changes', 'snapshot', 'interval', 'depth', 'keys', 'exclude', 'remotes']) {
    const v = url.searchParams.get(k);
    if (v !== null) env[k] = ['depth', 'interval'].includes(k) ? Number(v) : ['keys', 'exclude'].includes(k) ? v : /^(1|true)$/.test(v);
  }
  let keepalive;
  clients.set(client, (line) => {
    const m = /^\{"id":1,"status":"(\w+)"(?:,"body":)?/.exec(line);
    if (!m) return res.write(line + '\n');
    if (m[1] !== 'ok') return res.writeHead(STATUS[m[1]] ?? 500, { ...cors, 'Content-Type': 'application/json' }).end(line.slice(m[0].length, -1));
    res.writeHead(200, { ...cors, 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    if (env.snapshot !== false) res.write(`{"op":"change","path":${JSON.stringify(env.path)},"body":${line.slice(m[0].length, -1)}}\n`);
    else res.flushHeaders();
    keepalive = setInterval(() => res.write('\n'), 15000);
  });
  res.on('close', () => {
    clearInterval(keepalive);
    clients.delete(client);
    sendShared(client, 'close');
  });
  sendShared(client, JSON.stringify(env));
}

new WebSocketServer({ server, path: '/ws' }).on('connection', (ws) => {
  const deliver = (line) => ws.readyState === ws.OPEN && ws.send(line);
  if (isolated) {
    const p = node([], deliver);
    ws.on('message', (data) => p.stdin.write(String(data).replace(/\n/g, ' ') + '\n'));
    ws.on('close', () => p.kill());
    return;
  }
  const client = nextClient++;
  clients.set(client, deliver);
  ws.on('message', (data) => sendShared(client, String(data)));
  ws.on('close', () => {
    clients.delete(client);
    sendShared(client, 'close');
  });
});

server.listen(port, () => console.log(`${tree} node${isolated ? ' (isolated clients)' : ''}: http://localhost:${port}/`));
