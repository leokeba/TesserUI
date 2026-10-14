import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { after, before, test } from 'node:test';

// The bridge proxying a fake node: request bodies stream through, with
// their length (a node reads no chunked body).
let node, bridge, base;
const seen = [];

before(async () => {
  node = createServer(async (req, res) => {
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"label":"Fake"}');
    const got = { headers: req.headers, bytes: 0, chunks: [] };
    seen.push(got);
    for await (const c of req) (got.bytes += c.length), got.chunks.push(Date.now());
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ bytes: got.bytes }));
  });
  node.listen(0, '127.0.0.1');
  await once(node, 'listening');
  const port = 20000 + Math.floor(Math.random() * 20000);
  bridge = spawn(process.execPath, ['bridge.mjs', '--port', String(port), '--no-mdns', '--no-serial', '--node', `127.0.0.1:${node.address().port}`], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'inherit'] });
  await once(bridge.stdout, 'data');
  base = `http://127.0.0.1:${port}/n/127.0.0.1%3A${node.address().port}/api`;
});

after(() => {
  bridge.kill();
  node.close();
});

test('an upload streams through to the node, with its length', async () => {
  const pieces = 4, size = 16384, gap = 300;
  const sent = [];
  const reply = new Promise((done, fail) => {
    const out = request(`${base}/ota/firmware`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': pieces * size } }, async (r) => {
      let s = '';
      for await (const c of r) s += c;
      done({ status: r.statusCode, body: s });
    });
    out.on('error', fail);
    (async () => {
      for (let i = 0; i < pieces; i++) {
        out.write(Buffer.alloc(size, i));
        sent.push(Date.now());
        await new Promise((r) => setTimeout(r, gap));
      }
      out.end();
    })();
  });
  const r = await reply;
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { bytes: pieces * size });
  const got = seen.at(-1);
  assert.equal(got.headers['content-length'], String(pieces * size));
  assert.equal(got.headers['transfer-encoding'], undefined);
  // The node had the first piece before the page sent the last one.
  assert.ok(got.chunks[0] < sent.at(-1), 'streamed, not buffered');
});

test('reads pass through', async () => {
  const r = await fetch(`${base}/?view=schema`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { label: 'Fake' });
});
