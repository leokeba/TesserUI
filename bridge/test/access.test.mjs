import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocket } from 'ws';

// Who may use the bridge (DESIGN.md §9.7): requests to localhost by name,
// from the launcher's origin, its own or one given; never another site's.
let bridge, port;

before(async () => {
  port = 20000 + Math.floor(Math.random() * 20000);
  bridge = spawn(process.execPath, ['bridge.mjs', '--port', String(port), '--no-mdns', '--origin', 'http://localhost:5173'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] });
  await once(bridge.stdout, 'data');
});

after(() => bridge.kill());

// GET /nodes with these headers: its status, and the CORS origin it allows.
function get(headers, path = '/nodes') {
  return new Promise((done, fail) => {
    const r = request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      res.resume();
      done({ status: res.statusCode, cors: res.headers['access-control-allow-origin'] });
    });
    r.on('error', fail);
    r.end();
  });
}

test('only by the name localhost: a rebound name is refused', async () => {
  assert.equal((await get({})).status, 200);
  assert.equal((await get({ host: `127.0.0.1:${port}` })).status, 200);
  assert.equal((await get({ host: `evil.example:${port}` })).status, 403);
  assert.equal((await get({ host: 'localhost' })).status, 403);
});

test("the launcher's origin, its own and those given; no other", async () => {
  assert.deepEqual(await get({ origin: 'https://leokeba.github.io' }), { status: 200, cors: 'https://leokeba.github.io' });
  assert.deepEqual(await get({ origin: `http://localhost:${port}` }), { status: 200, cors: `http://localhost:${port}` });
  assert.deepEqual(await get({ origin: 'http://localhost:5173' }), { status: 200, cors: 'http://localhost:5173' });
  assert.equal((await get({ origin: 'http://localhost:8000' })).status, 403);
  assert.equal((await get({ origin: 'https://evil.example' })).status, 403);
});

test("without an Origin: tools, its own page and navigations; not another site's requests", async () => {
  assert.equal((await get({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })).status, 200);
  assert.equal((await get({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })).status, 200);
  assert.equal((await get({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' })).status, 200);
  assert.equal((await get({ 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' })).status, 403);
  assert.equal((await get({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors' })).status, 403);
});

// Opens a WebSocket: true if it opened, else false.
function opens(path, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { host: `localhost:${port}`, ...headers } });
  return new Promise((done) => {
    ws.on('open', () => (ws.close(), done(true)));
    ws.on('error', () => done(false));
  });
}

test('a serial port only if the bridge lists it', async () => {
  assert.equal(await opens(`/s/${encodeURIComponent('/etc/hosts')}`, { origin: 'https://leokeba.github.io' }), false);
  assert.equal(await opens(`/s/${encodeURIComponent('/dev/null')}`, { origin: 'https://leokeba.github.io' }), false);
});
